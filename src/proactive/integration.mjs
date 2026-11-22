import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { OrgError, text } from '../org-store.mjs';
import { CAPABILITIES, DEFAULT_POLICY } from './policy.mjs';
import { JobStore } from './store.mjs';
import { ProactiveService } from './service.mjs';
import { date, verifyWebhook } from './triggers.mjs';

export class ModelGateway {
  constructor(ctx, runtime) { Object.assign(this, { ctx, runtime }); }

  async complete({ actorId, system, payload, maxTokens, signal }) {
    const bot = this.runtime.botOf(actorId);
    const ref = bot?.model ?? this.runtime.defaultRef();
    if (!bot || typeof ref !== 'string' || ref.indexOf('/') < 1) throw new OrgError('Choose a DSH model for this Bot before enabling autonomy.');
    const [provider, ...parts] = ref.split('/');
    const model = parts.join('/');
    const assembler = new BlockAssembler();
    const message = createUserMessage({ content: [{ type: 'text', text: payload }] });
    for await (const chunk of this.ctx.llm.stream({
      provider, model, messages: [message], system,
      maxTokens, tools: [], sessionId: this.runtime.chatOf(bot.id), signal
    })) assembler.push(chunk);
    signal.throwIfAborted();
    if (!assembler.finish || ['error', 'aborted', 'max-tokens', 'tool-use'].includes(assembler.finish.kind)) throw new OrgError('DSH model did not return a complete bounded response.');
    const content = assembler.blocks();
    if (content.some(block => block.type !== 'text' && block.type !== 'reasoning')) throw new OrgError('Unexpected model tool or content block.');
    const reply = content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let value;
    try { value = JSON.parse(reply); }
    catch { throw new OrgError('DSH model returned invalid JSON.'); }
    const usage = assembler.usage;
    const tokens = usage?.totalTokens ?? (usage && usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
    return { value, tokens, model: ref };
  }
}

const boardStatus = {
  queued: 'todo', waiting_dependency: 'waiting', running: 'in_progress', waiting_approval: 'waiting',
  retry_scheduled: 'waiting', paused: 'waiting', succeeded: 'finished', failed: 'aborted', cancelled: 'aborted', timed_out: 'aborted'
};

function page(records, cursor, limit) {
  return { records, next: records.length === limit ? cursor(records.at(-1)) : null };
}

export function installProactive(ctx, home, runtime, organisation) {
  const db = new JobStore(join(home, 'proactive.sqlite'));
  const company = id => {
    const snapshot = organisation.snapshot();
    const found = snapshot.companies.find(value => value.id === id);
    if (!found) return null;
    return { ...found, chiefId: snapshot.chief?.id, employees: found.departments.flatMap(dep => dep.employees) };
  };
  const service = new ProactiveService({ db, organisation: { company }, model: new ModelGateway(ctx, runtime),
    writable: () => !runtime.readOnly(), notify: payload => { if (process.connected) process.send({ type: 'proactive-notification', ...payload }); } });
  const registrations = [
    ['org_goal_list', 'List the long-term goals in your company.', 'goal'],
    ['org_trigger_list', 'List triggers for your company.', 'trigger'],
    ['org_opportunity_list', 'List proactive opportunities in your company.', 'opportunity'],
    ['org_plan_list', 'List durable plans in your company.', 'plan'],
    ['org_workflow_status', 'List workflow status in your company.', 'runs'],
    ['org_activity_list', 'Read the company activity log.', 'activity']
  ];
  const param = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
  const register = (name, description, parameters, execute) => runtime.addTeamTool(defineTool({
    name, description, parameters: { company_id: param('Company ID', true), ...parameters },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(input, exec) {
      await runtime.load();
      const actor = organisation.actorOf(exec);
      service.assertBot(input.company_id, actor.id);
      return JSON.stringify(await execute(input, actor.id));
    }
  }));
  for (const [name, description, kind] of registrations) register(name, description, {}, (input, actor) => query(input.company_id, kind, {}, actor));
  register('org_goal_propose', 'Propose a goal for human review. Proposals cannot enable autonomy.', {
    title: param('Title', true), intent: param('Intent', true), success_criteria: param('Success criteria', true), parent_id: param('Parent goal ID')
  }, (input, actor) => {
    organisation.writable();
    return service.saveGoal(input.company_id, { title: input.title, intent: input.intent, successCriteria: input.success_criteria, parentId: input.parent_id, ownerId: actor }, actor);
  });
  register('org_trigger_propose', 'Propose a disabled interval trigger for human review.', {
    goal_id: param('Goal ID', true), name: param('Name', true), interval_minutes: { type: 'number', required: true, description: 'At least 5 minutes' }
  }, (input, actor) => {
    organisation.writable();
    return service.putTrigger(input.company_id, { type: 'interval', goalId: input.goal_id, name: input.name, intervalMinutes: input.interval_minutes, actorId: actor }, actor);
  });
  register('org_opportunity_propose', 'Record a suggestion for this company. Suggestions do not execute.', {
    goal_id: param('Goal ID', true), rationale: param('Suggestion and reason', true)
  }, (input, actor) => {
    organisation.writable();
    const goal = db.get('goal', input.company_id, input.goal_id);
    if (!goal || typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 1400) throw new OrgError('Invalid goal or suggestion.');
    return db.put('opportunity', input.company_id, 'bot:' + actor + ':' + goal.id, {
      decision: 'SUGGEST', rationale: input.rationale, goalId: goal.id, goalVersion: goal.version, status: 'recorded', actorId: actor
    });
  });

  function query(companyId, kind, input, actor = 'owner') {
    service.company(companyId);
    const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit, 100)) : 30;
    if (actor !== 'owner' && !['goal', 'trigger', 'opportunity', 'plan', 'runs', 'activity'].includes(kind)) throw new OrgError('Host owner required.');
    if (kind === 'runs') return page(db.jobs(companyId, limit).map(({ checkpoint, leaseOwner, ...job }) => job), () => null, limit);
    if (kind === 'activity') return page(db.activity(companyId, Number.isSafeInteger(input.cursor) ? input.cursor : undefined, limit), row => row.seq, limit);
    if (kind === 'policy') return { records: db.all('policy', companyId), defaults: DEFAULT_POLICY, capabilities: CAPABILITIES };
    if (kind === 'metrics') {
      const count = (kind, test) => db.all(kind, companyId).filter(test).length;
      const jobs = db.db.prepare('SELECT status,count(*) count FROM jobs WHERE company=? GROUP BY status').all(companyId);
      return { engine: service.suspended ? 'suspended' : service.health ?? (service.leader ? 'local_running' : 'standby'),
        jobs, usage24h: db.totals(companyId, 'company', service.clock() - 86_400_000),
        activeGoals: count('goal', goal => goal.status === 'active'), achievedGoals: count('goal', goal => goal.status === 'achieved'),
        opportunityCount: count('opportunity', () => true), approvalsPending: count('approval', item => item.status === 'pending'),
        approvalsExpired: count('approval', item => item.status === 'expired'), duplicatesSuppressed: count('opportunity', item => item.suppression === 'duplicate_or_cooldown') };
    }
    if (!['goal', 'goalVersion', 'trigger', 'opportunity', 'plan', 'approval', 'notification', 'event', 'memory'].includes(kind)) throw new OrgError('Unknown proactive list.');
    const before = Number.isSafeInteger(input.cursor?.time) ? input.cursor.time : undefined;
    const afterId = typeof input.cursor?.id === 'string' ? input.cursor.id : undefined;
    const records = db.list(kind, companyId, { before, afterId, limit }).map(row => {
      if (kind === 'trigger' && actor !== 'owner') {
        const { secretEnv, ...visible } = row;
        return visible;
      }
      if (kind === 'trigger' && ['webhook', 'github'].includes(row.type)) return { ...row,
        sourceState: webhook?.listening && process.env[row.secretEnv]?.length >= 24 ? 'listening' : 'not_connected',
        webhookPath: '/webhooks/' + row.id };
      return row;
    });
    return page(records, row => ({ time: row.updatedAt, id: row.id }), limit);
  }

  function action(input) {
    // Called exclusively by the owner-only DSH connection Fetch route.
    const companyId = input.companyId;
    service.company(companyId);
    if (input.action === 'proactive:list') return query(companyId, input.kind, input);
    organisation.writable();
    if (input.action === 'proactive:goal') return service.saveGoal(companyId, input.value);
    if (input.action === 'proactive:policy') return service.setPolicy(companyId, input.value);
    if (input.action === 'proactive:trigger') return service.putTrigger(companyId, input.value);
    if (input.action === 'proactive:trigger-now') return service.triggerNow(companyId, input.value);
    if (input.action === 'proactive:approval') return service.approval(companyId, input.value);
    if (input.action === 'proactive:verify') return service.verify(companyId, input.value);
    if (input.action === 'proactive:workflow') return service.control(companyId, input.value);
    if (input.action === 'proactive:memory') {
      const value = input.value;
      if (value.operation === 'remove') return db.remove('memory', companyId, text(value.id, 'Memory ID', 100));
      const id = value.id || randomUUID();
      return db.transaction(() => {
        const old = db.get('memory', companyId, id);
        if (value.id && old?.revision !== value.revision) throw new OrgError('Memory changed. Reload before saving.');
        return db.put('memory', companyId, id, {
          title: text(value.title, 'Memory title', 160), content: text(value.content, 'Confirmed background', 3000),
          provenance: text(value.provenance, 'Memory source', 500), revision: (old?.revision ?? 0) + 1,
          permission: 'company', confirmedBy: 'owner', expiresAt: value.expiresAt ? date(value.expiresAt, 'Memory expiry') : null
        });
      });
    }
    if (input.action === 'proactive:export-traces') {
      const rows = db.activity(companyId, undefined, 10000).reverse();
      if (input.format === 'csv') {
        const headers = ['seq', 'at', 'trace', 'type', 'goalId', 'jobId', 'tool', 'status', 'reason', 'tokens', 'verdict'];
        return [headers.join(','), ...rows.map(row => headers.map(key => '"' + String(row[key] ?? '').replaceAll('"', '""') + '"').join(','))].join('\n') + '\n';
      }
      return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    }
    throw new OrgError('Unknown proactive action.');
  }

  function projectTasks(companyId) {
    return db.jobs(companyId, 1000).filter(job => job.kind === 'work').map(job => ({
      ...job.task, id: job.id, workflowRunId: job.id, ownerId: job.actorId, goalId: job.goalId, parentTaskId: job.parentTaskId,
      source: 'proactive', status: boardStatus[job.status], workflowStatus: job.status, attempts: job.attempt,
      nextRetryAt: job.status === 'retry_scheduled' ? job.due : null, reason: job.reason, deadline: job.deadline, risk: job.risk,
      approvalStatus: job.status === 'waiting_approval' ? 'pending' : null, verificationStatus: job.verificationStatus ?? 'unverified',
      result: job.result, evidence: job.evidence?.map(item => item.kind + ' · ' + item.id + ' · sha256:' + item.hash).join('\n'),
      traceId: job.traceId, dependencies: job.dependencies, history: []
    }));
  }

  let webhook;
  const stop = service.launch();
  ctx.effect(() => {
    const port = Number(process.env.BOTORGHQ_WEBHOOK_PORT ?? 0);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      webhook = createServer(async (req, res) => {
        res.setHeader('cache-control', 'no-store');
        const match = /^\/webhooks\/([a-f\d-]{36})$/.exec(req.url ?? '');
        if (req.method !== 'POST' || !match) { res.writeHead(404).end(); return; }
        const trigger = db.all('trigger').find(value => value.id === match[1] && ['github', 'webhook'].includes(value.type));
        if (!trigger || runtime.readOnly() || !db.leads(service.id)) { res.writeHead(404).end(); return; }
        let size = 0;
        try {
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 256 * 1024) { res.writeHead(413).end(); return; }
            chunks.push(chunk);
          }
          const value = verifyWebhook({ trigger, raw: Buffer.concat(chunks), headers: new Headers(req.headers),
            secret: process.env[trigger.secretEnv], now: service.clock() });
          const { duplicate } = service.recordEvent(trigger.companyId, { ...value, goalId: trigger.goalId, actorId: trigger.actorId });
          res.writeHead(duplicate ? 200 : 202).end();
        } catch (error) {
          res.writeHead(error instanceof OrgError ? 403 : 503).end();
        }
      });
      webhook.requestTimeout = 10_000;
      webhook.on('error', () => { service.health = 'webhook_listener_error'; });
      webhook.listen(port, '127.0.0.1');
      webhook.unref();
    }
    const observe = setInterval(() => {
      if (!service.leader || service.stopped || service.suspended || runtime.readOnly()) return;
      try {
        for (const company of organisation.snapshot().companies) {
          if (service.policy(company.id).mode !== 'OFF') service.observeTasks(company.id, company.tasks);
        }
      } catch { service.health = 'task_observation_error'; }
    }, 15_000);
    observe.unref();
    const receive = message => { if (message?.type === 'proactive-suspend') service.suspend(message.value === true); };
    if (process.connected) process.on('message', receive);
    return async () => {
      process.off('message', receive);
      clearInterval(observe);
      const closed = webhook ? new Promise(resolve => {
        webhook.close(resolve);
        webhook.closeAllConnections();
      }) : Promise.resolve();
      try { await Promise.all([stop(), closed]); }
      finally { db.close(); }
    };
  }, 'BotOrgHQ proactive autonomy');
  return { action, projectTasks, service };
}

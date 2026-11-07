import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deepSeekEngine } from '../src/engines.mjs';
import { validatePlan, validateWork } from '../src/plan.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

function employee(ref, manager, name = ref) {
  return { ref, manager, name, role: '员工', mission: '处理文字任务。' };
}

test('Chief can hire employees across reporting levels in any plan order', () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.createCompany('Research', 'Research evidence');
    const bots = store.bots(id);
    const result = validatePlan({
      reply: 'Team ready',
      hires: [employee('new:analyst', 'new:lead'), employee('new:lead', bots[0].id)],
      tasks: [{ bot: 'new:analyst', title: 'Research', brief: 'List the evidence.' }]
    }, bots);
    assert.equal(result.hires[0].managerId, bots[0].id);
    assert.equal(result.hires[1].managerId, result.hires[0].id);
    assert.equal(result.tasks[0].botId, result.hires[1].id);
  } finally {
    store.close();
  }
});

test('Cross-company managers and tasks, cyclic reporting and peer delegation are rejected', () => {
  const store = new Store(':memory:');
  try {
    const a = store.createCompany('A', 'A mission');
    const b = store.createCompany('B', 'B mission');
    const bots = store.bots(a.id);
    const [foreign] = store.bots(b.id);
    assert.throws(() => validatePlan({
      reply: 'Invalid', hires: [employee('new:analyst', foreign.id)], tasks: []
    }, bots), /不在本公司/);
    assert.throws(() => validatePlan({
      reply: 'Invalid', hires: [employee('new:a', 'new:b'), employee('new:b', 'new:a')], tasks: []
    }, bots), /循环/);
    assert.throws(() => validatePlan({
      reply: 'Invalid', hires: [], tasks: [{ bot: foreign.id, title: 'Task', brief: 'Brief' }]
    }, bots), /不在本公司/);
    assert.throws(() => validateWork({
      output: 'Invalid', delegations: [{ bot: bots[0].id, title: 'Task', brief: 'Brief' }]
    }, []), /直属下属/);
    assert.throws(() => store.addBot(a.id, {
      id: randomUUID(), managerId: foreign.id, name: 'Outsider', role: 'Role', mission: 'Mission'
    }), /FOREIGN KEY/);

    store.enqueue(a.id, 'One more employee', 'demo');
    const job = store.claim('demo');
    assert.throws(() => store.finishPlan(job, {
      reply: 'Invalid',
      hires: [{ id: randomUUID(), managerId: bots[0].id, name: 'Valid', role: 'Analyst', mission: 'Mission' }],
      tasks: [{ botId: foreign.id, name: 'Outsider', title: 'Foreign task', brief: 'Brief' }]
    }), /FOREIGN KEY/);
    const view = store.snapshot(a.id);
    assert.equal(view.bots.length, 1);
    assert.equal(view.requests[0].status, 'running');
    assert.equal(view.activity.some(event => event.kind === 'bot.hired'), false);
  } finally {
    store.close();
  }
});

test('Restart marks interrupted work and preserves pending jobs in the current mode', t => {
  const folder = mkdtempSync(join(tmpdir(), 'bot-org-hq-test-'));
  t.after(() => rmSync(folder, { force: true, recursive: true }));
  const file = join(folder, 'workspace.sqlite');
  const first = new Store(file);
  const company = first.createCompany('A', 'Mission');
  const interrupted = first.enqueue(company.id, 'Start this', 'demo');
  assert.equal(first.claim('demo').id, interrupted);
  const pending = first.enqueue(company.id, 'Keep queued', 'demo');
  const wrongMode = first.enqueue(company.id, 'Wrong mode', 'deepseek');
  assert.throws(() => new Store(file), /locked/);
  first.close();

  const next = new Store(file);
  try {
    next.recover('demo');
    const requests = new Map(next.snapshot(company.id).requests.map(request => [request.id, request]));
    assert.equal(requests.get(interrupted).status, 'failed');
    assert.equal(requests.get(wrongMode).status, 'failed');
    assert.equal(requests.get(pending).status, 'queued');
    assert.equal(next.claim('demo').id, pending);
  } finally {
    next.close();
  }
});

async function followStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async function waitFor(predicate) {
    while (true) {
      const separator = buffer.indexOf('\n\n');
      if (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) {
          const snapshot = JSON.parse(data.slice(6));
          if (predicate(snapshot)) return snapshot;
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Company stream ended');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

test('HTTP and SSE show Chief hiring, manager delegation and isolated employee results', { timeout: 8000 }, async t => {
  const store = new Store(':memory:');
  const managerGate = Promise.withResolvers();
  const employeeGate = Promise.withResolvers();
  const watched = new AbortController();
  const result = 'Written report. '.repeat(100);
  const seen = [];

  const app = createApp(store, {
    mode: 'deepseek',
    async plan(context) {
      const { company, bots, history, prompt } = context;
      seen.push({ company: company.name, history });
      if (prompt === 'Review') return { reply: 'Reviewed', hires: [], tasks: [] };
      return {
        reply: 'Hiring',
        hires: [employee('new:lead', bots[0].id, 'Team Lead'), employee('new:staff', 'new:lead', 'Researcher')],
        tasks: [{ bot: 'new:lead', title: 'Plan', brief: 'Plan the deliverables' }]
      };
    },
    async execute({ task, reports }) {
      if (task.title === 'Plan') {
        await managerGate.promise;
        return { output: 'Plan ready', delegations: [{ bot: reports[0].id, title: 'Research', brief: 'Draft findings' }] };
      }
      await employeeGate.promise;
      return { output: result, delegations: [] };
    }
  });

  t.after(async () => {
    managerGate.resolve();
    employeeGate.resolve();
    watched.abort();
    await app.close();
    store.close();
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, init) => fetch(base + path, init);
  const post = (path, body, origin = base) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body)
  });
  const addCompany = async name => {
    const response = await post('/api/companies', { name, mission: 'Test mission' });
    assert.equal(response.status, 201);
    return (await response.json()).company;
  };
  const a = await addCompany('Company A');
  const b = await addCompany('Company B');
  assert.equal((await post('/api/companies', { name: 'No', mission: 'No' }, 'https://outside.example')).status, 403);
  const stream = await request(`/api/companies/${a.id}/events`, {
    signal: AbortSignal.any([watched.signal, AbortSignal.timeout(6000)])
  });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const until = await followStream(stream);
  const initial = await until(() => true);
  assert.equal(initial.bots.length, 1);

  assert.equal((await post(`/api/companies/${a.id}/chief`, { prompt: 'Hire' })).status, 202);
  const planning = await until(view => view.requests[0]?.status === 'running');
  assert.equal(planning.bots.length, 1);
  const managerWorking = await until(view => view.tasks.some(task => task.title === 'Plan' && task.status === 'running'));
  const lead = managerWorking.bots.find(bot => bot.name === 'Team Lead');
  const researcher = managerWorking.bots.find(bot => bot.name === 'Researcher');
  assert.equal(researcher.managerId, lead.id);

  managerGate.resolve();
  const workerWorking = await until(view => view.tasks.some(task => task.title === 'Research' && task.status === 'running'));
  const job = workerWorking.tasks.find(task => task.title === 'Research');
  assert.equal(job.botId, researcher.id);
  assert.equal(job.delegatedBy, 'Team Lead');
  employeeGate.resolve();
  const finished = await until(view => view.tasks.find(task => task.id === job.id)?.status === 'completed');
  assert.equal(finished.tasks.find(task => task.id === job.id).truncated, 1);
  const taskResponse = await request(`/api/companies/${a.id}/tasks/${job.id}`);
  assert.equal((await taskResponse.json()).output, result.trim());
  assert.equal((await request(`/api/companies/${b.id}/tasks/${job.id}`)).status, 404);

  const otherCompany = await request(`/api/companies/${b.id}`).then(response => response.json());
  assert.equal(otherCompany.bots.length, 1);
  assert.deepEqual(otherCompany.tasks, []);
  await post(`/api/companies/${a.id}/chief`, { prompt: 'Review' });
  await until(view => view.requests[0]?.output === 'Reviewed');
  assert.equal(seen.at(-1).company, 'Company A');
  assert.ok(seen.at(-1).history.results.some(item => item.name === 'Researcher'));
  assert.ok(store.workerContext(a.id, lead.id, 'deepseek').some(item => item.name === 'Researcher'));
  assert.deepEqual(store.chiefContext(b.id, 'deepseek').results, []);
});

test('DeepSeek adapter requests structured Chief plans and keeps provider error details out of the app', async () => {
  const signal = new AbortController().signal;
  const context = { company: { name: 'Test' }, bots: [], history: {}, prompt: 'Assemble a team', signal };
  const plan = { reply: 'Hello', hires: [], tasks: [] };
  const engine = deepSeekEngine({
    key: 'fake-key', fetcher: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'deepseek-flash');
      assert.equal(body.response_format.type, 'json_object');
      assert.equal(JSON.parse(body.messages[1].content).company.name, 'Test');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }] });
    }
  });
  assert.deepEqual(await engine.plan(context), plan);
  const unauthorized = deepSeekEngine({
    key: 'fake-key', fetcher: async () => new Response('Do not repeat fake-key', { status: 401 })
  });
  await assert.rejects(unauthorized.plan(context), error => error.message.includes('401') && !error.message.includes('fake-key'));
});

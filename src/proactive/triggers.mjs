import { createHmac, timingSafeEqual } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { OrgError, text } from '../org-store.mjs';
import { digest, validZone } from './policy.mjs';
import { githubEvent } from './github-source.mjs';

export const minute = 60_000;
export const day = 24 * 60 * minute;
export const GITHUB_TYPES = ['push', 'issues', 'pull_request', 'workflow_run'];
export const INTERNAL_TYPES = ['goal.changed', 'goal.overdue', 'task.created', 'task.updated', 'task.finished',
  'task.blocked', 'workflow.failed', 'workflow.recovered', 'approval.granted', 'approval.denied',
  'approval.expired', 'employee.idle', 'budget.threshold', 'scheduled.due'];
export const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;

export function date(value, label) {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || !Number.isFinite(Date.parse(value))) throw new OrgError(label + ' needs an ISO time with offset.');
  return Date.parse(value);
}

export function nextDue(trigger, now) {
  if (trigger.type === 'interval' || trigger.type === 'heartbeat') return now + trigger.intervalMinutes * minute;
  if (trigger.type === 'cron') {
    try { return CronExpressionParser.parse(trigger.cron, { currentDate: new Date(now), tz: trigger.timezone }).next().getTime(); }
    catch { throw new OrgError('Invalid cron expression or no next occurrence.'); }
  }
  if (trigger.type === 'once') return trigger.at > now ? trigger.at : null;
  return null;
}

export function makeTrigger(input, now) {
  const type = input.type;
  if (!['once', 'interval', 'heartbeat', 'cron', 'github', 'webhook', 'internal'].includes(type)) throw new OrgError('Unknown trigger type.');
  const trigger = {
    name: text(input.name, 'Trigger name', 120), type, goalId: text(input.goalId, 'Goal ID', 100),
    enabled: input.enabled !== false, actorId: input.actorId || null, catchUp: input.catchUp === 'latest' ? 'latest' : 'skip',
    timezone: validZone(input.timezone || 'UTC'), lastAt: null, sourceState: 'ready'
  };
  if (type === 'interval' || type === 'heartbeat') {
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 5 || input.intervalMinutes > 10080) throw new OrgError('Interval must be 5–10080 minutes.');
    trigger.intervalMinutes = input.intervalMinutes;
  }
  if (type === 'once') trigger.at = date(input.at, 'One-time trigger');
  if (type === 'cron') {
    trigger.cron = text(input.cron, 'Cron schedule', 100);
    if (trigger.cron.split(/\s+/).length !== 5) throw new OrgError('Cron requires five fields, at minute granularity.');
  }
  if (type === 'internal' || type === 'github') {
    const possible = type === 'internal' ? INTERNAL_TYPES : GITHUB_TYPES;
    if (!Array.isArray(input.events) || !input.events.length || !input.events.every(event => possible.includes(event))) throw new OrgError('Choose supported event types.');
    trigger.events = [...new Set(input.events)];
  }
  if (type === 'github') {
    trigger.repository = text(input.repository, 'Repository', 120).toLowerCase();
    if (!/^[\w.-]+\/[\w.-]+$/.test(trigger.repository)) throw new OrgError('Repository must be owner/name.');
    trigger.pollTokenEnv = input.pollTokenEnv ? text(input.pollTokenEnv, 'GitHub read token environment variable', 80) : null;
    if (trigger.pollTokenEnv && !/^BOTORGHQ_GITHUB_READ_[A-Z0-9_]+$/.test(trigger.pollTokenEnv)) throw new OrgError('Use a BOTORGHQ_GITHUB_READ_ variable name.');
    trigger.pollCursor = now;
    trigger.pollAfter = now;
  }
  if (type === 'github' || type === 'webhook') {
    trigger.secretEnv = text(input.secretEnv, 'Secret environment variable', 80);
    if (!/^BOTORGHQ_WEBHOOK_[A-Z0-9_]+$/.test(trigger.secretEnv)) throw new OrgError('Use a BOTORGHQ_WEBHOOK_ environment variable name.');
    trigger.sourceState = 'not_connected';
  }
  trigger.nextAt = nextDue(trigger, now);
  if (type === 'once' && trigger.nextAt === null) throw new OrgError('One-time trigger must be in the future.');
  return trigger;
}

function excerpt(value, limit = 500) { return typeof value === 'string' ? value.slice(0, limit) : null; }

export function verifyWebhook({ trigger, raw, headers, secret, now }) {
  if (!trigger.enabled || !secret || secret.length < 24) throw new OrgError('Webhook not configured.');
  if (raw.length > 256 * 1024) throw new OrgError('Webhook body too large.');
  const github = trigger.type === 'github';
  const delivery = headers.get(github ? 'x-github-delivery' : 'x-botorg-id');
  const time = headers.get('x-botorg-time');
  const type = github ? headers.get('x-github-event') : 'webhook.received';
  if (!delivery || !/^[\w.-]{1,120}$/.test(delivery)) throw new OrgError('Missing webhook delivery ID.');
  if (!github && (!time || !/^\d{10,13}$/.test(time) || Math.abs(now - Number(time.padEnd(13, '0'))) > 5 * minute)) throw new OrgError('Expired webhook.');
  if (github && !trigger.events.includes(type)) throw new OrgError('GitHub event not subscribed.');
  const supplied = headers.get(github ? 'x-hub-signature-256' : 'x-botorg-signature');
  const hmac = createHmac('sha256', secret);
  if (!github) hmac.update(time + '.' + delivery + '.');
  const expected = hmac.update(raw).digest();
  if (!/^sha256=[a-f\d]{64}$/i.test(supplied ?? '') || !timingSafeEqual(Buffer.from(supplied.slice(7), 'hex'), expected)) throw new OrgError('Webhook authentication failed.');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { throw new OrgError('Invalid webhook JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OrgError('Invalid webhook object.');
  if (github && body.repository?.full_name?.toLowerCase?.() !== trigger.repository) throw new OrgError('GitHub repository does not match.');
  if (github) {
    const subject = type === 'issues' ? body.issue : type === 'push' ? (body.head_commit ?? body) : body[type];
    if (!subject || (type !== 'push' && typeof subject.id !== 'number') || (type === 'push' && typeof body.ref !== 'string')) {
      throw new OrgError('GitHub payload does not match the subscribed event.');
    }
    const date = Date.parse(subject.updated_at ?? subject.timestamp ?? '');
    const event = githubEvent(trigger, type, delivery, body, subject, Number.isFinite(date) ? date : null);
    return { ...event, bodyHash: digest(raw.toString('utf8')) };
  }
  const subject = body;
  const payload = {
    title: excerpt(subject.title ?? subject.name ?? subject.message ?? body.ref),
    summary: excerpt(subject.summary ?? subject.body ?? subject.message, 1800),
    action: excerpt(body.action), conclusion: excerpt(subject.conclusion), ref: excerpt(body.ref ?? subject.head_sha ?? body.after),
    url: github && typeof subject.html_url === 'string' && subject.html_url.toLowerCase().startsWith('https://github.com/' + trigger.repository + '/') ? excerpt(subject.html_url) : null,
    repository: github ? trigger.repository : null
  };
  // GitHub signs the body, but not the delivery header. Also deduplicate signed bytes.
  const bodyHash = digest(raw.toString('utf8'));
  return { type: github ? 'github.' + type : type, source: trigger.id, subjectId: excerpt(String(subject.id ?? delivery)),
    payload, dedupeKey: delivery, bodyHash, occurredAt: Number(time.padEnd(13, '0')), scope: 'company', trustLevel: 'external' };
}

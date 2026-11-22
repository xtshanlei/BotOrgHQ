import { digest } from './policy.mjs';
const minute = 60_000;
const githubTypes = ['push', 'issues', 'pull_request', 'workflow_run'];

export function githubLogicalKey(type, payload) {
  if (type === 'push' && typeof payload.ref === 'string') {
    const commit = payload.after ?? payload.head;
    return typeof commit === 'string' ? digest([type, payload.ref, commit]) : undefined;
  }
  const subject = payload[type === 'issues' ? 'issue' : type];
  if (!subject?.id) return undefined;
  if (type === 'workflow_run') return digest([type, subject.id, subject.run_attempt ?? 1, subject.status, subject.conclusion]);
  if (subject.updated_at && payload.action) return digest([type, subject.id, subject.updated_at, payload.action]);
  return undefined;
}

export async function readGitHubEvents(trigger, secret, cursor, signal, fetchRequest = fetch, now = Date.now()) {
  const floor = Math.max(cursor, now - 6 * 60 * minute);
  const repository = trigger.repository;
  const parts = repository.split('/').map(encodeURIComponent).join('/');
  const read = async endpoint => {
    const response = await fetchRequest('https://api.github.com/repos/' + parts + endpoint, { redirect: 'error', signal,
      headers: { authorization: 'Bearer ' + secret, accept: 'application/vnd.github+json', 'user-agent': 'BotOrgHQ/0.4' } });
    if (!response.ok) throw new Error('github_http_' + response.status);
    return response.json();
  };
  const events = [];
  if (trigger.events.some(type => type !== 'workflow_run')) {
    const feed = await read('/events?per_page=100');
    if (!Array.isArray(feed)) throw new Error('github_invalid_feed');
    const types = { PushEvent: 'push', IssuesEvent: 'issues', PullRequestEvent: 'pull_request' };
    for (const item of feed) {
      const type = types[item.type];
      const created = Date.parse(item.created_at);
      if (!type || !trigger.events.includes(type) || !Number.isFinite(created) || created < floor || !item.id) continue;
      const subject = item.payload?.[type === 'issues' ? 'issue' : type] ?? item.payload ?? {};
      events.push({ type, at: created, id: String(item.id), subject, body: item.payload ?? {} });
    }
  }
  if (trigger.events.includes('workflow_run')) {
    const feed = await read('/actions/runs?per_page=100');
    if (!Array.isArray(feed.workflow_runs)) throw new Error('github_invalid_workflow_feed');
    for (const run of feed.workflow_runs) {
      const updated = Date.parse(run.updated_at);
      if (run.status !== 'completed' || !Number.isFinite(updated) || updated < floor || !run.id) continue;
      events.push({ type: 'workflow_run', at: updated, id: String(run.id) + ':' + (run.run_attempt ?? 1), subject: run,
        body: { workflow_run: run, action: 'completed' } });
    }
  }
  return events.sort((a, b) => a.at - b.at).map(event => githubEvent(trigger, event.type, event.id, event.body, event.subject, event.at));
}

function excerpt(value, limit = 500) { return typeof value === 'string' ? value.slice(0, limit) : null; }

export function githubEvent(trigger, type, id, body, subject, occurredAt) {
  if (!githubTypes.includes(type)) throw new Error('Invalid GitHub event type.');
  return { type: 'github.' + type, source: trigger.id, subjectId: excerpt(String(subject.id ?? id)), dedupeKey: id,
    logicalKey: githubLogicalKey(type, body), occurredAt: occurredAt ?? null, trustLevel: 'external', scope: 'github:' + trigger.repository,
    payload: { title: excerpt(subject.title ?? subject.name ?? subject.message ?? body.ref),
      summary: excerpt(subject.body ?? subject.message, 1800), action: excerpt(body.action), conclusion: excerpt(subject.conclusion),
      ref: excerpt(body.ref ?? subject.head_sha ?? body.after ?? body.head), repository: trigger.repository,
      url: typeof subject.html_url === 'string' && subject.html_url.toLowerCase().startsWith('https://github.com/' + trigger.repository + '/') ? excerpt(subject.html_url) : null } };
}

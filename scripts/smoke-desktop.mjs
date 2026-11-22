import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startEngine } from '../desktop/engine.mjs';
import { backupData } from '../desktop/data.mjs';
import { exportProfile, importProfile } from '../desktop/profile-transfer.mjs';

const runtime = resolve(process.argv[2] ?? 'desktop/runtime');
const home = await mkdtemp(join(tmpdir(), 'botorg-smoke-'));
let engine;
async function boot(data = join(home, 'dsh')) {
  engine = startEngine(runtime, data);
  const url = await engine.ready;
  const launch = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const cookie = launch.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie, 'Packaged DSH must issue a session cookie');
  const endpoint = new URL('/api/bot-org-hq', url);
  const probe = headers => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'proactive:list' }),
    signal: AbortSignal.timeout(20_000)
  });
  assert.equal((await probe({})).status, 401, 'Unauthenticated access is denied');
  assert.equal((await probe({ cookie, origin: 'https://untrusted.invalid' })).status, 403, 'Cross-origin access is denied');
  return async (action, fields = {}) => {
    const result = await fetch(new URL('/api/bot-org-hq', url), {
      method: 'POST', headers: { cookie, origin: url.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...fields }), signal: AbortSignal.timeout(30_000)
    });
    const data = await result.json();
    assert(result.ok, data.error);
    return data.value;
  };
}
try {
  const { ModelGateway } = await import(pathToFileURL(join(runtime, 'node_modules', 'bot-org-hq', 'src', 'proactive', 'integration.mjs')).href);
  const gateway = new ModelGateway({ llm: { async *stream(options) {
    assert.equal(options.provider, 'configured-provider');
    assert.equal(options.model, 'chosen-model');
    assert.equal(options.sessionId, 'existing-native-session');
    assert.equal(options.system, 'bounded instructions');
    assert.deepEqual(options.tools, []);
    assert.equal(options.messages[0].content[0].text, '{"data":"test"}');
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"IGNORE"}' } };
    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } }, { botOf: () => ({ id: 'chief', model: 'configured-provider/chosen-model' }), chatOf: () => 'existing-native-session' });
  const response = await gateway.complete({ actorId: 'chief', system: 'bounded instructions', payload: '{"data":"test"}',
    maxTokens: 100, signal: AbortSignal.timeout(2000) });
  assert.equal(response.value.decision, 'IGNORE');
  assert.equal(response.tokens, 55);
  let call = await boot();
  const initial = await call('state');
  assert(initial.chief?.sessionId, 'Chief session must initialise');
  const company = await call('create-company', { name: 'Persistent smoke company' });
  const department = await call('create-department', { companyId: company.id, name: 'Evidence' });
  const task = await call('create-task', { companyId: company.id, title: 'Verify retained state', expectedResult: 'Saved record', acceptanceCriteria: 'Survives restart', requestId: 'restart-test' });
  await call('update-task', { companyId: company.id, taskId: task.id, revision: task.revision, status: 'finished', result: 'Persisted', evidence: 'Native host smoke test' });
  const query = (kind) => call('proactive:list', { companyId: company.id, kind });
  assert.equal((await query('policy')).defaults.mode, 'OFF');
  await call('proactive:policy', { companyId: company.id, value: { revision: 0, mode: 'SUGGEST', allowedTools: [] } });
  const goal = await call('proactive:goal', { companyId: company.id, value: {
    title: 'Persistent goal', intent: 'Keep native data', successCriteria: 'Survives restart', status: 'active'
  } });
  await call('proactive:trigger', { companyId: company.id, value: {
    type: 'heartbeat', name: 'Persistent trigger', goalId: goal.id, intervalMinutes: 5
  } });
  assert.equal((await query('trigger')).records[0].type, 'heartbeat');
  const shutdown = await engine.stop();
  assert(!shutdown.forced, 'Normal host shutdown must release the SQLite worker');
  const archive = join(home, 'profile.bohq');
  const password = 'smoke-test-recovery-password';
  await exportProfile(join(home, 'dsh'), archive, password);
  const importedHome = join(home, 'fresh-import');
  await importProfile(importedHome, archive, password);
  assert((await readFile(join(importedHome, 'bot-org-hq', 'proactive.sqlite'))).length > 0);
  const backup = await backupData(home, '0.3.0', 'smoke-test');
  assert.equal(JSON.parse(await readFile(join(backup, 'dsh', 'bot-org-hq', 'organisation.json'), 'utf8')).tasks[0].status, 'finished');
  call = await boot();
  const recovered = await call('state');
  assert.equal(recovered.chief.sessionId, initial.chief.sessionId);
  assert.equal(recovered.companies[0].id, company.id);
  assert.equal(recovered.companies[0].departments[0].id, department.id);
  assert.equal(recovered.companies[0].tasks[0].status, 'finished');
  assert.equal((await call('proactive:list', { companyId: company.id, kind: 'goal' })).records[0].id, goal.id);
  await engine.stop();
  call = await boot(importedHome);
  const imported = await call('state');
  assert.equal(imported.chief.sessionId, initial.chief.sessionId);
  assert.equal(imported.companies[0].id, company.id);
  assert.equal((await call('proactive:list', { companyId: company.id, kind: 'policy' })).records[0].stopped, true);
  console.log('Packaged DSH authentication, model adapter contract, goal and task APIs, backup, import and restart passed.');
} finally {
  await engine?.stop();
  await rm(home, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startEngine } from '../desktop/engine.mjs';
import { backupData } from '../desktop/data.mjs';

const runtime = resolve(process.argv[2] ?? 'desktop/runtime');
const home = await mkdtemp(join(tmpdir(), 'botorg-smoke-'));
let engine;
async function boot() {
  engine = startEngine(runtime, join(home, 'dsh'));
  const url = await engine.ready;
  const launch = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const cookie = launch.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie, 'Packaged DSH must issue a session cookie');
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
  let call = await boot();
  const initial = await call('state');
  assert(initial.chief?.sessionId, 'Chief session must initialise');
  const company = await call('create-company', { name: 'Persistent smoke company' });
  const department = await call('create-department', { companyId: company.id, name: 'Evidence' });
  const task = await call('create-task', { companyId: company.id, title: 'Verify retained state', expectedResult: 'Saved record', acceptanceCriteria: 'Survives restart', requestId: 'restart-test' });
  await call('update-task', { companyId: company.id, taskId: task.id, revision: task.revision, status: 'finished', result: 'Persisted', evidence: 'Native host smoke test' });
  await engine.stop();
  const backup = await backupData(home, '0.3.0', 'smoke-test');
  assert.equal(JSON.parse(await readFile(join(backup, 'dsh', 'bot-org-hq', 'organisation.json'), 'utf8')).tasks[0].status, 'finished');
  call = await boot();
  const recovered = await call('state');
  assert.equal(recovered.chief.sessionId, initial.chief.sessionId);
  assert.equal(recovered.companies[0].id, company.id);
  assert.equal(recovered.companies[0].departments[0].id, department.id);
  assert.equal(recovered.companies[0].tasks[0].status, 'finished');
  console.log('Packaged DSH, Chief, task API, backup and restart checks passed.');
} finally {
  await engine?.stop();
  await rm(home, { recursive: true, force: true });
}

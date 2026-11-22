import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportProfile, importProfile, rollbackImport } from '../desktop/profile-transfer.mjs';

test('Portable encrypted archive round trips profile, sessions, Bot memory, tasks and settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bohq-portable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'source');
  const target = join(directory, 'target');
  const file = join(directory, 'profile.bohq');
  const password = 'long-local-recovery-password';
  const paths = ['profiles/botorg-hq/config.yml', 'sessions/x/log.jsonl', 'attachments/blob.bin', 'bot-org-hq/memory/team.md',
    'bot-org-hq/organisation.json', 'bot-org-hq/proactive.sqlite', 'credentials.json', '.botorghq-desktop.json'];
  const samples = [];
  for (const [index, name] of paths.entries()) {
    const data = Buffer.from('private-profile-content-' + name + String(index).repeat(130_000));
    const path = join(home, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, data);
    samples.push(data);
  }
  await mkdir(target);
  await writeFile(join(target, 'original'), 'original profile');
  await exportProfile(home, file, password);
  assert.equal((await readFile(file)).includes('private-profile-content'), false);
  await assert.rejects(importProfile(target, file, 'wrong-password-for-this-archive'));
  assert.equal(await readFile(join(target, 'original'), 'utf8'), 'original profile');
  assert.deepEqual((await readdir(directory)).sort(), ['profile.bohq', 'source', 'target']);
  const restored = await importProfile(target, file, password);
  for (const [index, name] of paths.entries()) assert.deepEqual(await readFile(join(target, name)), samples[index]);
  assert.equal(await readFile(join(target, '.botorghq-import-pause'), 'utf8'), '1\n');
  assert.equal(await readFile(join(restored.previous, 'original'), 'utf8'), 'original profile');
  await rollbackImport(restored);
  assert.equal(await readFile(join(target, 'original'), 'utf8'), 'original profile');
  await appendFile(file, 'tamper');
  await assert.rejects(importProfile(target, file, password));
  assert.equal(await readFile(join(target, 'original'), 'utf8'), 'original profile');
});

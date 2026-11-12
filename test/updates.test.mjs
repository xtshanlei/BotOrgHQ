import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupData, prepareData, recordVersion } from '../desktop/data.mjs';
import { checksumFor, DesktopUpdates, newerVersion, selectRelease } from '../desktop/updates.mjs';

const assetName = 'BotOrgHQ-0.4.0-mac-arm64.zip';
const release = { tag_name: 'v0.4.0-desktop', draft: false, prerelease: true, assets: [
  { name: assetName, id: 1, state: 'uploaded', size: 3 }, { name: 'SHA256SUMS.txt', id: 2, state: 'uploaded' }
] };

test('Update selection compares versions numerically and requires the matching native asset and checksums', () => {
  assert(newerVersion('v0.10.0-desktop', '0.9.9'));
  assert(!newerVersion('v0.2.0-desktop', '0.3.0'));
  assert(!newerVersion('v0.4.0-unverified', '0.3.0'));
  assert.equal(selectRelease([{ ...release, draft: true }], '0.3.0', 'darwin', 'arm64'), null);
  assert.equal(selectRelease([release], '0.3.0', 'darwin', 'x64'), null);
  assert.equal(selectRelease([release], '0.3.0', 'darwin', 'arm64').version, '0.4.0');
  assert.equal(selectRelease([{ ...release, assets: release.assets.slice(0, 1) }], '0.3.0', 'darwin', 'arm64'), null);
  assert.throws(() => checksumFor('invalid file', assetName), /checksum/);
});

test('Downloading verifies bytes, strips credentials on CDN redirects and cleans failed downloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bohq-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const digest = createHash('sha256').update('zip').digest('hex');
  let corrupt = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'api.github.com') {
      assert.equal(options.headers.authorization, 'Bearer private-test-token');
      if (target.pathname.endsWith('/2')) return new Response(`${digest}  ${assetName}\n`);
      if (target.pathname.endsWith('/1')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/installer' } });
      return Response.json([release]);
    }
    assert.equal(options.headers.authorization, undefined);
    return new Response(corrupt ? 'bad' : 'zip');
  });
  const updater = new DesktopUpdates({ directory, version: '0.3.0', platform: 'darwin', arch: 'arm64', token: () => 'private-test-token' });
  await updater.check();
  assert.equal(updater.state.phase, 'available');
  await updater.downloadUpdate();
  assert.equal(updater.state.phase, 'ready');
  assert.equal(await readFile(updater.download.file, 'utf8'), 'zip');
  corrupt = true;
  await updater.downloadUpdate();
  assert.equal(updater.state.phase, 'error');
  assert.equal(updater.download, null);
  assert.deepEqual(await readdir(directory), [assetName]);
  assert.equal(await readFile(join(directory, assetName), 'utf8'), 'zip');
});

test('Version upgrade snapshots native configuration, sessions, memory and organisation without changing originals', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bohq-data-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const names = ['profiles/botorg-hq/config.yml', 'sessions/a/session.json', 'bot-org-hq/memory/team.md', 'bot-org-hq/organisation.json'];
  for (const name of names) {
    const path = join(home, 'dsh', name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `saved data ${name}`);
  }
  await recordVersion(home, '0.2.0');
  await prepareData(home, '0.3.0');
  const snapshots = await readdir(join(home, 'backups'));
  assert.equal(snapshots.length, 1);
  for (const name of names) assert.equal(await readFile(join(home, 'backups', snapshots[0], 'dsh', name), 'utf8'), await readFile(join(home, 'dsh', name), 'utf8'));
  await recordVersion(home, '0.3.0');
  await prepareData(home, '0.3.0');
  assert.equal((await readdir(join(home, 'backups'))).length, 1);
  await backupData(home, '0.3.0', 'before-in-app-install');
  assert.equal((await readdir(join(home, 'backups'))).length, 2);
});

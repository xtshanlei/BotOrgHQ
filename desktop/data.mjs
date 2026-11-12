import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function readVersion(home) {
  try { return JSON.parse(await readFile(join(home, 'desktop-version.json'), 'utf8')).version; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The DSH host must be stopped before calling this function. Keep snapshots
// outside DSH_HOME so runtime migrations cannot rewrite the recovery copy.
export async function backupData(home, version, reason) {
  const backups = join(home, 'backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const partial = join(backups, `.${name}.partial`);
  const target = join(backups, name);
  await mkdir(partial, { mode: 0o700 });
  try {
    const data = await stat(join(home, 'dsh')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (data) await cp(join(home, 'dsh'), join(partial, 'dsh'), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await writeFile(join(partial, 'manifest.json'), JSON.stringify({ version, reason, createdAt: new Date().toISOString(), dataDirectory: home }, null, 2), { mode: 0o600 });
    await rename(partial, target);
    return target;
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareData(home, version) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const previous = await readVersion(home);
  if (previous !== version) {
    await backupData(home, previous ?? '0.2.0-or-earlier', 'before-runtime-upgrade');
  }
}

export async function recordVersion(home, version) {
  const partial = join(home, 'desktop-version.json.tmp');
  await writeFile(partial, JSON.stringify({ version }) + '\n', { mode: 0o600 });
  await rename(partial, join(home, 'desktop-version.json'));
}

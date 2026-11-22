import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { promisify } from 'node:util';

const MAGIC = Buffer.from('BOTORGHQ-PROFILE-1\n');
const TAG = 16;
const HEADER = MAGIC.length + 16 + 12;
const keyFor = promisify(scrypt);
const chunkBytes = 64 * 1024;
const lineLimit = 120 * 1024;

function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 512) throw new Error('Use a recovery password of 12–512 characters.');
  return value;
}

function contained(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function archivePath(root, value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:\x00-\x1f]/.test(value) ||
    value.split('/').some(part => !part || /[<>|"?*]|[. ]$/.test(part) || /^(con|aux|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Invalid or non-portable archive path.');
  const result = resolve(root, ...value.split('/'));
  if (!contained(root, result)) throw new Error('Archive path leaves the profile.');
  return result;
}

async function* entries(root, directory = root) {
  for (const entry of (await readdir(directory)).sort()) {
    const path = join(directory, entry);
    const name = relative(root, path).split(sep).join('/');
    archivePath(root, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      yield JSON.stringify({ kind: 'directory', name }) + '\n';
      yield* entries(root, path);
    } else if (info.isFile()) {
      yield JSON.stringify({ kind: 'file', name, size: info.size, executable: Boolean(info.mode & 0o100) }) + '\n';
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path, { highWaterMark: chunkBytes })) {
        hash.update(chunk);
        yield JSON.stringify({ kind: 'bytes', value: chunk.toString('base64') }) + '\n';
      }
      yield JSON.stringify({ kind: 'end', hash: hash.digest('hex') }) + '\n';
    } else if (info.isSymbolicLink()) {
      const destination = resolve(dirname(path), await readlink(path));
      if (!contained(root, destination)) throw new Error('A symbolic link leaves the workspace. Move external data separately.');
      yield JSON.stringify({ kind: 'symlink', name, target: relative(root, destination).split(sep).join('/') || '.' }) + '\n';
    } else {
      // Runtime sockets and pid locks are recreated on startup.
      if (!info.isSocket()) throw new Error('Unsupported profile entry: ' + name);
    }
  }
}

export async function exportProfile(dshHome, output, passphrase) {
  password(passphrase);
  const root = resolve(dshHome);
  if (!(await stat(root)).isDirectory()) throw new Error('DSH profile was not found.');
  if (contained(root, resolve(output))) throw new Error('Save the archive outside the live DSH directory.');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const key = await keyFor(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(header);
  const partial = output + '.' + randomUUID() + '.partial';
  const destination = await open(partial, 'wx', 0o600);
  try {
    await destination.writeFile(header);
    await pipeline(entries(root), createGzip(), cipher, createWriteStream(partial, { flags: 'a' }));
    await destination.write(cipher.getAuthTag(), 0, TAG, (await destination.stat()).size);
    await destination.sync();
    await destination.close();
    await rename(partial, output);
  } catch (error) {
    await destination.close().catch(() => {});
    await rm(partial, { force: true });
    throw error;
  }
}

async function decodeProfile(input, stage, passphrase) {
  const source = await open(input, 'r');
  const header = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  let size;
  try {
    size = (await source.stat()).size;
    if (size <= HEADER + TAG) throw new Error('Incomplete profile archive.');
    await source.read(header, 0, HEADER, 0);
    await source.read(tag, 0, TAG, size - TAG);
  } finally { await source.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unsupported profile archive format.');
  const key = await keyFor(password(passphrase), header.subarray(MAGIC.length, MAGIC.length + 16), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length + 16)).setAAD(header).setAuthTag(tag);
  const pipe = createGunzip();
  let streamError;
  const flowing = pipeline(createReadStream(input, { start: HEADER, end: size - TAG - 1 }), decipher, pipe)
    .catch(error => { streamError = error; });
  const lines = createInterface({ input: pipe, crlfDelay: Infinity });
  const links = [];
  const names = new Set();
  let file = null;
  let opened = null;
  try {
    for await (const line of lines) {
      if (line.length > lineLimit) throw new Error('Invalid archive block length.');
      const item = JSON.parse(line);
      if (item.kind === 'bytes') {
        if (!file || typeof item.value !== 'string') throw new Error('Unexpected archive data block.');
        const bytes = Buffer.from(item.value, 'base64');
        file.remaining -= bytes.length;
        if (file.remaining < 0 || bytes.length > chunkBytes) throw new Error('Invalid archive file size.');
        file.hash.update(bytes);
        await opened.writeFile(bytes);
        continue;
      }
      if (item.kind === 'end') {
        if (!file || file.remaining !== 0 || file.hash.digest('hex') !== item.hash) throw new Error('Profile file checksum mismatch.');
        await opened.close();
        opened = file = null;
        continue;
      }
      if (file) throw new Error('Incomplete archive entry.');
      const path = archivePath(stage, item.name);
      const key = process.platform === 'linux' ? item.name : item.name.toLowerCase();
      if (names.has(key)) throw new Error('Duplicate or conflicting archive path.');
      names.add(key);
      if (item.kind === 'directory') await mkdir(path, { mode: 0o700 });
      else if (item.kind === 'file' && Number.isSafeInteger(item.size) && item.size >= 0) {
        opened = await open(path, 'wx', item.executable ? 0o700 : 0o600);
        file = { remaining: item.size, hash: createHash('sha256') };
      } else if (item.kind === 'symlink') {
        const target = item.target === '.' ? stage : archivePath(stage, item.target);
        links.push({ path, target });
      } else throw new Error('Unknown profile archive entry.');
    }
    await flowing;
    if (streamError) throw new Error('The archive could not be authenticated. Check the password and file integrity.');
    if (file || !names.size) throw new Error('Archive is incomplete or empty.');
    for (const link of links) {
      const type = (await stat(link.target).catch(() => null))?.isDirectory() ? 'dir' : 'file';
      await symlink(relative(dirname(link.path), link.target) || '.', link.path, type);
    }
  } finally {
    lines.close();
    pipe.destroy();
    await flowing;
    await opened?.close();
  }
}

// Caller stops the DSH host before either operation and retains the returned
// original directory until the imported runtime has been checked.
export async function importProfile(dshHome, input, passphrase) {
  const root = resolve(dshHome);
  const stage = root + '.import-' + randomUUID();
  const previous = root + '.before-import-' + randomUUID();
  let moved = false;
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(stage, { mode: 0o700 });
  try {
    await decodeProfile(input, stage, passphrase);
    await writeFile(join(stage, '.botorghq-import-pause'), '1\n', { mode: 0o600 });
    try { await rename(root, previous); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, root); }
    catch (error) { if (moved) await rename(previous, root); throw error; }
    if (process.platform !== 'win32') await chmod(root, 0o700);
    return { root, previous: moved ? previous : null };
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
}

export async function rollbackImport({ root, previous }) {
  if (!previous) return;
  await rename(root, root + '.failed-import-' + randomUUID());
  await rename(previous, root);
}

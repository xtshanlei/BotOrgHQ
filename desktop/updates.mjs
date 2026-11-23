import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = 'xtshanlei/BotOrgHQ';
const api = `https://api.github.com/repos/${repository}`;

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-desktop)?$/.exec(value);
  return match?.slice(1).map(Number);
}

export function newerVersion(candidate, current) {
  const left = versionParts(candidate), right = versionParts(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

export function selectRelease(releases, version, platform, arch) {
  if (!['darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('This platform does not support in-app installation.');
  const candidates = releases.filter(release => !release.draft && newerVersion(release.tag_name, version))
    .sort((a, b) => newerVersion(a.tag_name, b.tag_name) ? -1 : 1);
  for (const release of candidates) {
    const number = versionParts(release.tag_name).join('.');
    const name = `BotOrgHQ-${number}-${platform === 'darwin' ? 'mac' : 'win'}-${arch}.${platform === 'darwin' ? 'zip' : 'exe'}`;
    const asset = release.assets?.find(item => item.name === name && item.state === 'uploaded');
    const checksums = release.assets?.find(item => item.name === 'SHA256SUMS.txt' && item.state === 'uploaded');
    if (asset && checksums) return { version: number, tag: release.tag_name, asset, checksums };
  }
  return null;
}

export function checksumFor(content, name) {
  const line = content.split(/\r?\n/).find(line => line.replace(/^[a-f\d]{64}\s+\*?/i, '') === name);
  if (!line || !/^[a-f\d]{64}\s+/i.test(line)) throw new Error('The update checksum is missing.');
  return line.slice(0, 64).toLowerCase();
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class DesktopUpdates {
  constructor({ directory, version, platform = process.platform, arch = process.arch, token = () => '' }) {
    Object.assign(this, { directory, version, platform, arch, token });
    this.state = { phase: 'idle', currentVersion: version, message: "Check for a newer version of BotOrgHQ." };
  }

  set(patch) {
    if (Object.hasOwn(patch, 'message')) delete this.state.messageValues;
    Object.assign(this.state, patch);
  }

  async request(url, binary = false) {
    let target = new URL(url);
    for (let attempt = 0; attempt < 6; attempt++) {
      if (target.protocol !== 'https:') throw new Error('The update server returned an insecure address.');
      const headers = { 'user-agent': 'BotOrgHQ', accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' };
      if (target.hostname === 'api.github.com' && this.token()) headers.authorization = `Bearer ${this.token()}`;
      const response = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(20 * 60_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location');
        await response.body?.cancel();
        if (!next) throw new Error('The update redirect is missing its address.');
        target = new URL(next, target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 404].includes(response.status)) throw new Error("GitHub could not access this release. For a private repository, save a GitHub token with Contents read permission and try again.");
        throw new Error(`Update server returned ${response.status}.`);
      }
      return response;
    }
    throw new Error('Too many update redirects.');
  }

  async check() {
    if (['checking', 'downloading', 'installing'].includes(this.state.phase)) return;
    this.release = null;
    this.download = null;
    this.set({ phase: 'checking', message: "Checking GitHub Releases…", version: null, progress: null });
    try {
      const response = await this.request(`${api}/releases?per_page=30`);
      const releases = await response.json();
      if (!Array.isArray(releases)) throw new Error('Invalid release feed.');
      this.release = selectRelease(releases, this.version, this.platform, this.arch);
      this.set(this.release ? { phase: 'available', version: this.release.version, message: "A new version is available to download." } : { phase: 'current', message: "You are on the latest available version." });
    } catch (error) { this.set({ phase: 'error', message: error.message }); }
  }

  async downloadUpdate() {
    if (!this.release || !['available', 'error', 'ready'].includes(this.state.phase)) return;
    this.download = null;
    this.set({ phase: 'downloading', message: "Downloading and verifying the update…", progress: 0 });
    const { asset, checksums, version } = this.release;
    const partial = join(this.directory, `${asset.name}.${randomUUID()}.part`);
    let handle;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const checksumResponse = await this.request(`${api}/releases/assets/${checksums.id}`, true);
      const expected = checksumFor(await checksumResponse.text(), asset.name);
      const response = await this.request(`${api}/releases/assets/${asset.id}`, true);
      handle = await open(partial, 'wx', 0o600);
      let received = 0, lastProgress = -1;
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > asset.size) throw new Error('The update size does not match its release metadata.');
        await handle.writeFile(chunk);
        const progress = Math.floor(received / asset.size * 100);
        if (progress !== lastProgress) { this.set({ progress }); lastProgress = progress; }
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (received !== asset.size || await hashFile(partial) !== expected) throw new Error("Update verification failed. Download it again.");
      const file = join(this.directory, asset.name);
      await rm(file, { force: true });
      await rename(partial, file);
      this.download = { file, expected, version };
      this.set({ phase: 'ready', progress: 100, message: "Download and SHA-256 verification complete. Tasks will stop and data will be backed up before installation." });
    } catch (error) { this.set({ phase: 'error', message: error.message }); }
    finally { await handle?.close(); await rm(partial, { force: true }); }
  }

  async prepareInstall(appPath) {
    if (this.state.phase !== 'ready' || !this.download) throw new Error("Finish downloading the update first.");
    if (await hashFile(this.download.file) !== this.download.expected) throw new Error("The downloaded file has changed. Download it again.");
    if (this.platform === 'win32') return { kind: 'windows', file: this.download.file };
    if (!appPath.endsWith('.app') || appPath.includes('/AppTranslocation/')) throw new Error("Move BotOrgHQ to Applications before installing the update.");
    const staging = join(this.directory, `mac-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    await run('/usr/bin/ditto', ['-x', '-k', this.download.file, staging]);
    const source = join(staging, 'BotOrgHQ.app');
    const plist = join(source, 'Contents', 'Info.plist');
    const identity = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
    const bundleVersion = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
    if (identity.stdout.trim() !== 'io.github.xtshanlei.botorg-hq' || bundleVersion.stdout.trim() !== this.download.version) throw new Error("The downloaded app has an unexpected identity or version.");
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
    const target = `${appPath}.update-${randomUUID()}`;
    const previous = `${appPath}.previous-${randomUUID()}`;
    await run('/usr/bin/ditto', [source, target]);
    const script = join(this.directory, `install-${randomUUID()}.sh`);
    await writeFile(script, `#!/bin/sh
set -eu
parent_pid="$1"
target="$2"
destination="$3"
previous="$4"
count=0
while kill -0 "$parent_pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -gt 120 ]; then exit 1; fi
  sleep 1
done
if mv "$destination" "$previous"; then
  if mv "$target" "$destination"; then
    /usr/bin/open "$destination"
  else
    mv "$previous" "$destination"
    /usr/bin/open "$destination"
    exit 1
  fi
fi
`, { mode: 0o700 });
    await chmod(script, 0o700);
    return { kind: 'mac', script, target, destination: appPath, previous };
  }

  async launchInstall(installation) {
    const command = installation.kind === 'windows' ? installation.file : '/bin/sh';
    const args = installation.kind === 'windows' ? [] : [installation.script, String(process.pid), installation.target, installation.destination, installation.previous];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
}

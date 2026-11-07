import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = dirname(fileURLToPath(import.meta.url));
const source = dirname(desktop);
const plugin = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const dsh = plugin.engines.dsh;
const runtime = join(desktop, 'runtime');
const staging = mkdtempSync(join(desktop, '.runtime-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run prepare-runtime from the desktop package.');

function run(args, cwd) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.status}).`);
}

try {
  const archive = `${plugin.name}-${plugin.version}.tgz`;
  run(['pack', '--pack-destination', staging], source);
  const peers = ['dsh-llm', 'dsh-scope', 'dsh-tools', 'dsh-web'];
  writeFileSync(join(staging, 'package.json'), JSON.stringify({
    name: 'botorg-hq-runtime',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh': dsh,
      '@deepseek-ai/dsh-app-boot': dsh,
      '@deepseek-ai/dsh-base': dsh,
      '@deepseek-ai/dsh-web-app': dsh,
      [plugin.name]: `file:./${archive}`
    },
    overrides: Object.fromEntries(peers.map(name => [`@deepseek-ai/${name}`, dsh]))
  }, null, 2) + '\n');
  run(['install', '--omit=dev', '--no-audit', '--no-fund'], staging);
  rmSync(join(staging, archive));
  mkdirSync(join(staging, 'bin'));
  cpSync(process.execPath, join(staging, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
  cpSync(join(desktop, 'host.mjs'), join(staging, 'host.mjs'));
  rmSync(runtime, { recursive: true, force: true });
  chmodSync(staging, 0o755);
  renameSync(staging, runtime);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

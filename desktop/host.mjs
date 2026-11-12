// Uses the application-owned profile pattern from DS Bot and DeepSeek Harness.
import { fileURLToPath } from 'node:url';
import { initProfile, loadLayeredEnv, loadProfileDirectory, resolveProfileDir } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const name = 'botorg-hq';
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'bot-org-hq'];
const installAnchor = fileURLToPath(new URL('./package.json', import.meta.url));
if (!process.env.DSH_HOME || !process.connected) throw new Error('Launch the DSH host from BotOrgHQ Desktop.');

async function boot() {
  const dir = resolveProfileDir(name);
  initProfile(dir, bundles);
  const profile = loadProfileDirectory('dsh', dir, installAnchor);
  if (profile.skippedBundles.some(item => bundles.includes(item.packageName))) {
    throw new Error('A bundled BotOrgHQ component is unavailable.');
  }
  return runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: name,
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0']
  });
}

const application = boot();
let stopping;
function stop() {
  stopping ??= (async () => {
    const running = await application.catch(() => undefined);
    try {
      await running?.shutdown.shutdown(0);
    } finally {
      if (process.connected) process.disconnect();
    }
  })();
  return stopping;
}
process.on('message', message => { if (message?.type === 'stop') void stop(); });
process.once('disconnect', () => { void stop(); });
try {
  const { ctx } = await application;
  if (!stopping) {
    const port = ctx.get('webServer')?.port;
    const connection = ctx.get('connection');
    if (!port || !connection || !ctx.get('sessionController')) throw new Error('DSH did not start its desktop services.');
    process.send({ type: 'ready', url: connection.authenticatedUrl(`http://127.0.0.1:${port}`) });
  }
} catch (error) {
  process.exitCode = 1;
  if (process.connected) process.send({ type: 'error', message: String(error.message).replace(/([?&]token=)[^&\s]+/g, '$1[hidden]') });
  await stop();
}


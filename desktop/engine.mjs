import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const executable = process.platform === 'win32' ? 'node.exe' : 'node';
const redact = text => text.replace(/([?&]token=)[^&\s]+/g, '$1[hidden]');

export function startEngine(runtime, home, onUnexpectedExit) {
  mkdirSync(home, { recursive: true });
  const child = spawn(join(runtime, 'bin', executable), [join(runtime, 'host.mjs')], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
  let stopping = false;
  let started = false;
  let tail = '';
  let stopPromise;
  let forcedStop = false;
  const exited = new Promise(resolve => child.once('close', resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The built-in DSH host did not become ready.')), 60_000);
    const failure = message => {
      clearTimeout(timer);
      reject(new Error(redact(message)));
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-4000); });
    child.once('error', error => failure(error.message));
    child.once('close', code => {
      const message = redact(`The DSH host exited (${code ?? 'signal'}).${tail ? '\n' + tail.trim() : ''}`);
      if (!started) failure(message);
      else if (!stopping) onUnexpectedExit?.(new Error(message));
    });
    child.on('message', message => {
      if (message?.type === 'error') failure(message.message);
      if (message?.type !== 'ready' || started) return;
      try {
        const url = new URL(message.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !url.searchParams.has('token')) {
          throw new Error('The DSH host returned an invalid launch address.');
        }
        clearTimeout(timer);
        started = true;
        resolve(url);
      } catch (error) {
        failure(error.message);
      }
    });
  });
  function stop() {
    stopping = true;
    stopPromise ??= (async () => {
      if (child.connected) child.send({ type: 'stop' }, () => {});
      const timer = setTimeout(() => { forcedStop = true; child.kill('SIGKILL'); }, 30_000);
      try { await exited; } finally { clearTimeout(timer); }
      return { forced: forcedStop };
    })();
    return stopPromise;
  }
  return { ready, stop };
}


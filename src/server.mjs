import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, InputError } from './store.mjs';
import { deepSeekEngine, demoEngine, seedDemo } from './engines.mjs';
import { Runtime } from './runtime.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const security = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function send(res, status, content) {
  res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(content));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, '请使用 application/json。');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > 24 * 1024) {
      req.resume();
      throw new HttpError(413, '请求内容太大。');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
    return value;
  } catch {
    throw new HttpError(400, '请求须为 JSON 对象。');
  }
}

export function createApp(store, engine) {
  const files = new Map([
    ['/', ['text/html', 'index.html']],
    ['/app.js', ['text/javascript', 'app.js']],
    ['/styles.css', ['text/css', 'styles.css']]
  ].map(([route, [type, file]]) => [route, { type, body: readFileSync(new URL(`../public/${file}`, import.meta.url)) }]));

  const streams = new Map();
  const frame = snapshot => `event: company\ndata: ${JSON.stringify(snapshot)}\n\n`;
  const runtime = new Runtime(store, engine, companyId => {
    const connections = streams.get(companyId);
    if (!connections?.size) return;
    const payload = frame(store.snapshot(companyId));
    for (const res of connections) {
      if (res.writableLength > 512 * 1024) res.destroy();
      else res.write(payload);
    }
  });

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
        throw new HttpError(403, '请通过本机地址访问。');
      }
      const origin = `http://${host}`;
      if (req.headers.origin && req.headers.origin !== origin) {
        throw new HttpError(403, '跨站请求被拒绝。');
      }
      const { pathname } = new URL(req.url, origin);
      const file = files.get(pathname);
      if (req.method === 'GET' && file) {
        res.writeHead(200, { ...security, 'Content-Type': `${file.type}; charset=utf-8` });
        res.end(file.body);
        return;
      }
      if (pathname === '/api/companies') {
        if (req.method === 'GET') {
          send(res, 200, { mode: engine.mode, companies: store.companies() });
          return;
        }
        if (req.method === 'POST') {
          const { name, mission } = await readBody(req);
          send(res, 201, { company: store.createCompany(name, mission) });
          return;
        }
      }

      const match = pathname.match(/^\/api\/companies\/([a-f0-9-]{36})(?:\/(events|chief)|\/tasks\/([a-f0-9-]{36}))?$/);
      if (!match || !store.company(match[1])) throw new HttpError(404, '页面或公司不存在。');
      const [, companyId, action, taskId] = match;
      if (req.method === 'GET' && taskId) {
        const task = store.taskDetail(companyId, taskId);
        if (!task) throw new HttpError(404, '当前公司内没有该任务。');
        send(res, 200, task);
        return;
      }
      if (req.method === 'GET' && !action) {
        send(res, 200, store.snapshot(companyId));
        return;
      }
      if (req.method === 'GET' && action === 'events') {
        const clients = streams.get(companyId) ?? new Set();
        if (clients.size >= 12) throw new HttpError(429, '实时连接已达上限。');
        const payload = frame(store.snapshot(companyId));
        res.writeHead(200, {
          ...security, 'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no'
        });
        res.write(payload);
        streams.set(companyId, clients);
        clients.add(res);
        res.on('close', () => {
          clients.delete(res);
          if (!clients.size) streams.delete(companyId);
        });
        return;
      }
      if (req.method === 'POST' && action === 'chief') {
        const { prompt } = await readBody(req);
        send(res, 202, { id: runtime.submit(companyId, prompt) });
        return;
      }
      throw new HttpError(405, '该请求方法不可用。');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : error instanceof InputError ? 400 : 500;
      if (status === 500) console.error('Request failed:', error.code ?? error.name);
      send(res, status, { error: status === 500 ? '本地服务出现错误。' : error.message });
    }
  });

  const heartbeat = setInterval(() => {
    for (const clients of streams.values()) {
      for (const res of clients) {
        if (res.writableLength > 512 * 1024) res.destroy();
        else res.write(': heartbeat\n\n');
      }
    }
  }, 20_000).unref();

  return {
    server,
    runtime,
    async close() {
      clearInterval(heartbeat);
      const stopped = new Promise(resolve => server.close(resolve));
      for (const clients of streams.values()) for (const res of clients) res.end();
      await Promise.all([runtime.close(), stopped]);
    }
  };
}

async function start() {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  const engine = key ? deepSeekEngine({ key, model: process.env.DEEPSEEK_MODEL?.trim() || undefined }) : demoEngine();
  const port = Number(process.env.PORT ?? '3030');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535.');
  const dataDir = resolve(process.env.BOT_ORG_HQ_DATA_DIR || 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(resolve(dataDir, engine.mode === 'demo' ? 'demo.sqlite' : 'companies.sqlite'));
  const app = createApp(store, engine);
  if (engine.mode === 'demo') seedDemo(store);
  let closing;
  const stop = () => closing ??= app.close().finally(() => store.close());
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`BotOrgHQ: http://127.0.0.1:${port} (${engine.mode})`);
    app.runtime.wake();
  });
  app.server.on('error', error => {
    console.error(`Unable to listen: ${error.code ?? error.name}`);
    process.exitCode = 1;
    void stop();
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  start().catch(error => {
    console.error(`Unable to start BotOrgHQ: ${error.message}`);
    process.exitCode = 1;
  });
}

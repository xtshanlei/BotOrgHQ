import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class InputError extends Error {}

const schema = `
  CREATE TABLE IF NOT EXISTS company (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mission TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS bot (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES company(id),
    manager_id TEXT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    mission TEXT NOT NULL,
    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, manager_id) REFERENCES bot(company_id, id)
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS one_company_root ON bot(company_id)
    WHERE manager_id IS NULL;

  CREATE TABLE IF NOT EXISTS request (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES company(id),
    prompt TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('demo', 'deepseek')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    output TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (company_id, id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS task (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    parent_task_id TEXT,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    output TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (company_id, request_id, id),
    FOREIGN KEY (company_id, request_id) REFERENCES request(company_id, id),
    FOREIGN KEY (company_id, bot_id) REFERENCES bot(company_id, id),
    FOREIGN KEY (company_id, request_id, parent_task_id) REFERENCES task(company_id, request_id, id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES company(id),
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS request_queue ON request(status, created_at);
  CREATE INDEX IF NOT EXISTS request_company ON request(company_id, created_at);
  CREATE INDEX IF NOT EXISTS task_queue ON task(status, created_at);
  CREATE INDEX IF NOT EXISTS task_company ON task(company_id, created_at);
  CREATE INDEX IF NOT EXISTS activity_company ON activity(company_id, id);
`;

function clean(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new InputError(`${label}须为 1–${max} 个字符。`);
  }
  return value.trim();
}

export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    // One local server owns a database. An exclusive lock makes recovery safe on restart.
    try {
      this.db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA foreign_keys = ON;');
      this.transaction(() => this.db.exec(schema));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  transaction(action) {
    this.db.exec('BEGIN EXCLUSIVE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  activity(companyId, kind, detail) {
    this.run('INSERT INTO activity(company_id, kind, detail, created_at) VALUES (?, ?, ?, ?)',
      companyId, kind, detail, Date.now());
  }

  companies() {
    return this.all('SELECT id, name, mission FROM company ORDER BY created_at, rowid');
  }

  company(companyId) {
    return this.get('SELECT id, name, mission FROM company WHERE id = ?', companyId);
  }

  bots(companyId) {
    return this.all(`SELECT id, manager_id AS managerId, name, role, mission FROM bot
      WHERE company_id = ? ORDER BY rowid`, companyId);
  }

  reports(companyId, managerId) {
    return this.all('SELECT id, name, role, mission FROM bot WHERE company_id = ? AND manager_id = ? ORDER BY rowid',
      companyId, managerId);
  }

  createCompany(name, mission) {
    name = clean(name, '公司名称', 48);
    mission = clean(mission, '公司使命', 500);
    const id = randomUUID();
    this.transaction(() => {
      this.run('INSERT INTO company VALUES (?, ?, ?, ?)', id, name, mission, Date.now());
      this.addBot(id, {
        id: randomUUID(), managerId: null, name: '公司负责人',
        role: '总经理', mission: '对齐公司目标，统筹部门及其交付。'
      });
      this.activity(id, 'company.created', '公司成立，已任命公司负责人。');
    });
    return { id, name, mission };
  }

  addBot(companyId, bot) {
    this.run(`INSERT INTO bot(id, company_id, manager_id, name, role, mission)
      VALUES (?, ?, ?, ?, ?, ?)`, bot.id, companyId, bot.managerId, bot.name, bot.role, bot.mission);
  }

  enqueue(companyId, prompt, mode) {
    prompt = clean(prompt, '目标', 4000);
    const id = randomUUID();
    this.transaction(() => {
      const pending = this.get(`SELECT count(*) AS count FROM request
        WHERE company_id = ? AND status IN ('queued', 'running')`, companyId);
      if (pending.count >= 8) throw new InputError('Chief 队列已满，请等待当前请求处理。');
      this.run(`INSERT INTO request(id, company_id, prompt, mode, status, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)`, id, companyId, prompt, mode, Date.now());
      this.activity(companyId, 'chief.queued', 'Chief 收到一条新指令。');
    });
    return id;
  }

  snapshot(companyId) {
    const company = this.company(companyId);
    if (!company) return null;
    return {
      company,
      bots: this.bots(companyId),
      requests: this.all(`SELECT id, prompt, mode, status, output, created_at AS createdAt
        FROM request WHERE company_id = ? ORDER BY rowid DESC LIMIT 24`, companyId),
      tasks: this.all(`WITH ranked AS (
        SELECT t.id, t.bot_id AS botId, t.title, substr(t.brief, 1, 480) AS brief,
          t.status, substr(t.output, 1, 900) AS output, manager.name AS delegatedBy,
          (length(t.brief) > 480 OR coalesce(length(t.output), 0) > 900) AS truncated,
          t.rowid AS sequence, row_number() OVER (PARTITION BY t.bot_id ORDER BY t.rowid DESC) AS rank
        FROM task t LEFT JOIN task parent ON parent.company_id = t.company_id AND parent.id = t.parent_task_id
        LEFT JOIN bot manager ON manager.company_id = t.company_id AND manager.id = parent.bot_id
        WHERE t.company_id = ?
      ) SELECT id, botId, title, brief, status, output, delegatedBy, truncated FROM ranked
        WHERE rank <= 4 OR status IN ('queued', 'running') ORDER BY sequence DESC`, companyId),
      activity: this.all(`SELECT id, kind, detail, created_at AS createdAt FROM activity
        WHERE company_id = ? ORDER BY id DESC LIMIT 30`, companyId)
    };
  }

  claim(mode) {
    return this.transaction(() => {
      const job = this.get(`
        SELECT id, company_id AS companyId, 'request' AS kind, created_at
        FROM request r WHERE status = 'queued' AND mode = ?
          AND NOT EXISTS (SELECT 1 FROM request WHERE company_id = r.company_id AND status = 'running')
        UNION ALL
        SELECT t.id, t.company_id, 'task', t.created_at FROM task t
        JOIN request r ON r.company_id = t.company_id AND r.id = t.request_id
        WHERE t.status = 'queued' AND r.mode = ?
          AND NOT EXISTS (SELECT 1 FROM task WHERE bot_id = t.bot_id AND status = 'running')
        ORDER BY created_at, kind, id LIMIT 1`, mode, mode);
      if (!job) return null;
      this.run(`UPDATE ${job.kind} SET status = 'running' WHERE id = ?`, job.id);
      if (job.kind === 'request') {
        this.activity(job.companyId, 'chief.started', 'Chief 正在分析目标和公司人员。');
      } else {
        const task = this.task(job.companyId, job.id);
        this.activity(job.companyId, 'task.started', `${task.name} 开始「${task.title}」。`);
      }
      return job;
    });
  }

  request(companyId, id) {
    return this.get('SELECT prompt, mode FROM request WHERE company_id = ? AND id = ?', companyId, id);
  }

  task(companyId, id) {
    return this.get(`SELECT t.bot_id AS botId, t.request_id AS requestId, t.title, t.brief, b.name, b.role, b.mission
      FROM task t JOIN bot b ON b.company_id = t.company_id AND b.id = t.bot_id
      WHERE t.company_id = ? AND t.id = ?`, companyId, id);
  }

  taskDetail(companyId, id) {
    return this.get('SELECT title, brief, status, output FROM task WHERE company_id = ? AND id = ?', companyId, id);
  }

  chiefContext(companyId, mode) {
    const exchanges = this.all(`SELECT substr(prompt, 1, 800) AS prompt, substr(output, 1, 800) AS reply
      FROM request WHERE company_id = ? AND mode = ? AND status = 'completed'
      ORDER BY rowid DESC LIMIT 4`, companyId, mode).reverse();
    const results = this.all(`SELECT t.title, b.name, substr(t.output, 1, 700) AS result FROM task t
      JOIN bot b ON b.company_id = t.company_id AND b.id = t.bot_id
      JOIN request r ON r.company_id = t.company_id AND r.id = t.request_id
      WHERE t.company_id = ? AND r.mode = ? AND t.status = 'completed' ORDER BY t.rowid DESC LIMIT 5`,
    companyId, mode).reverse();
    return { exchanges, results };
  }

  workerContext(companyId, botId, mode) {
    return this.all(`SELECT t.title, b.name, substr(t.output, 1, 800) AS result FROM task t
      JOIN request r ON r.company_id = t.company_id AND r.id = t.request_id
      JOIN bot b ON b.company_id = t.company_id AND b.id = t.bot_id
      LEFT JOIN task parent ON parent.company_id = t.company_id AND parent.id = t.parent_task_id
      WHERE t.company_id = ? AND (t.bot_id = ? OR parent.bot_id = ?) AND r.mode = ? AND t.status = 'completed'
      ORDER BY t.rowid DESC LIMIT 4`, companyId, botId, botId, mode).reverse();
  }

  finishPlan(job, plan) {
    this.transaction(() => {
      this.finish(job, 'completed', plan.reply);
      for (const bot of plan.hires) {
        this.addBot(job.companyId, bot);
        this.activity(job.companyId, 'bot.hired', `Chief 聘用了 ${bot.name}（${bot.role}）。`);
      }
      this.queueTasks(job.companyId, job.id, null, 'Chief', plan.tasks);
      this.activity(job.companyId, 'chief.completed', 'Chief 已提交回复。');
    });
  }

  finishTask(job, work) {
    this.transaction(() => {
      const task = this.task(job.companyId, job.id);
      this.finish(job, 'completed', work.output);
      this.activity(job.companyId, 'task.completed', `${task.name} 完成「${task.title}」。`);
      this.queueTasks(job.companyId, task.requestId, job.id, task.name, work.delegations);
    });
  }

  queueTasks(companyId, requestId, parentId, sender, assignments) {
    if (!assignments.length) return;
    const pending = this.get(`SELECT count(*) AS count FROM task
      WHERE company_id = ? AND status IN ('queued', 'running')`, companyId).count;
    const total = this.get('SELECT count(*) AS count FROM task WHERE company_id = ? AND request_id = ?',
      companyId, requestId).count;
    if (pending + assignments.length > 40) throw new InputError('公司任务队列已满，请等待任务完成后重试。');
    if (total + assignments.length > 24) throw new InputError('本轮请求已达到 24 个子任务的上限。');
    for (const task of assignments) {
      this.run(`INSERT INTO task(id, company_id, request_id, bot_id, parent_task_id, title, brief, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`, randomUUID(), companyId, requestId,
      task.botId, parentId, task.title, task.brief, Date.now());
      this.activity(companyId, 'task.queued', `${sender} 将「${task.title}」派给 ${task.name}。`);
    }
  }

  finish(job, status, output) {
    const change = this.run(`UPDATE ${job.kind} SET status = ?, output = ?
      WHERE company_id = ? AND id = ? AND status = 'running'`, status, output, job.companyId, job.id);
    if (!change.changes) throw new Error('Job is no longer running');
  }

  fail(job, message) {
    this.transaction(() => {
      this.finish(job, 'failed', message);
      const detail = job.kind === 'request' ? 'Chief 请求失败。'
        : `${this.task(job.companyId, job.id).name} 的任务失败。`;
      this.activity(job.companyId, job.kind === 'request' ? 'chief.failed' : 'task.failed', detail);
    });
  }

  recover(mode) {
    this.transaction(() => {
      for (const kind of ['request', 'task']) {
        const mismatched = kind === 'request' ? 'mode <> ?'
          : 'EXISTS (SELECT 1 FROM request r WHERE r.id = task.request_id AND r.mode <> ?)';
        const jobs = this.all(`SELECT id, company_id AS companyId, status FROM ${kind}
          WHERE status = 'running' OR (status = 'queued' AND ${mismatched})`, mode);
        for (const job of jobs) {
          this.run(`UPDATE ${kind} SET status = 'failed', output = ? WHERE id = ?`,
            job.status === 'running' ? '服务重启，任务中断。' : '运行模式变更，请重新提交。', job.id);
          this.activity(job.companyId, kind === 'request' ? 'chief.failed' : 'task.failed',
            job.status === 'running' ? '服务重启，上一轮工作中断。' : '运行模式变更，队列中的工作已停止。');
        }
      }
    });
  }
}

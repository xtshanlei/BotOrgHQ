import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ACTIVE = ['queued', 'running', 'waiting_dependency', 'waiting_approval', 'retry_scheduled', 'paused'];
const schema = `
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL, company TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
  updated INTEGER NOT NULL, PRIMARY KEY(kind, company, id)
);
CREATE INDEX IF NOT EXISTS records_scope ON records(kind, company, updated DESC, id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, company TEXT NOT NULL, goal TEXT NOT NULL, goal_version INTEGER NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, due INTEGER NOT NULL, value TEXT NOT NULL,
  owner TEXT, lease_until INTEGER, attempt INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT, UNIQUE(company, id)
);
CREATE INDEX IF NOT EXISTS job_work ON jobs(status, due, company);
CREATE INDEX IF NOT EXISTS job_goal ON jobs(company, goal, status);
CREATE TABLE IF NOT EXISTS leader (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expiry INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  job TEXT NOT NULL, key TEXT NOT NULL, company TEXT NOT NULL, scope TEXT NOT NULL,
  at INTEGER NOT NULL, tokens INTEGER NOT NULL, tool INTEGER NOT NULL,
  PRIMARY KEY(job, key, scope)
);
CREATE INDEX IF NOT EXISTS usage_scope ON usage(company, scope, at);
CREATE TABLE IF NOT EXISTS traces (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, trace TEXT NOT NULL,
  at INTEGER NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trace_scope ON traces(company, seq);
`;

const decode = row => row && JSON.parse(row.value);
const safeTraceFields = new Set(['goalId', 'goalVersion', 'eventId', 'correlationId', 'planVersion', 'jobId', 'actorId',
  'tool', 'status', 'reason', 'tokens', 'reportedTokens', 'ms', 'model', 'argsHash', 'approvalId', 'verdict', 'decision', 'retryAt']);

export class JobStore {
  constructor(path, clock = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.clock = clock;
    this.db = new DatabaseSync(path);
    if (process.platform !== 'win32' && path !== ':memory:') chmodSync(path, 0o600);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version > 1) throw new Error('Proactive database requires a newer BotOrgHQ.');
        if (!version) this.db.exec(schema + 'PRAGMA user_version=1;');
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(kind, company, id) {
    return decode(this.db.prepare('SELECT value FROM records WHERE kind=? AND company=? AND id=?').get(kind, company, id));
  }

  list(kind, company, { before = Number.MAX_SAFE_INTEGER, limit = 100, afterId = '' } = {}) {
    return this.db.prepare(`SELECT value FROM records WHERE kind=? AND company=?
      AND (updated<? OR (updated=? AND id>?)) ORDER BY updated DESC, id LIMIT ?`)
      .all(kind, company, before, before, afterId, limit).map(decode);
  }

  all(kind, company) {
    const sql = company === undefined ? 'SELECT value FROM records WHERE kind=?' : 'SELECT value FROM records WHERE kind=? AND company=?';
    return this.db.prepare(sql).all(...(company === undefined ? [kind] : [kind, company])).map(decode);
  }

  put(kind, company, id, item) {
    const value = { ...item, id, companyId: company, updatedAt: this.clock() };
    this.db.prepare(`INSERT INTO records VALUES(?,?,?,?,?)
      ON CONFLICT(kind,company,id) DO UPDATE SET value=excluded.value, updated=excluded.updated`)
      .run(kind, company, id, JSON.stringify(value), value.updatedAt);
    return value;
  }

  remove(kind, company, id) {
    return this.db.prepare('DELETE FROM records WHERE kind=? AND company=? AND id=?').run(kind, company, id).changes > 0;
  }

  enqueue({ id = randomUUID(), companyId, goalId, goalVersion, kind, status = 'queued', due = this.clock(), ...value }) {
    this.db.prepare(`INSERT OR IGNORE INTO jobs(id, company, goal, goal_version, kind, status, due, value)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, companyId, goalId, goalVersion, kind, status, due, JSON.stringify(value));
    return this.job(id);
  }

  #job(row) {
    if (!row) return null;
    return { ...JSON.parse(row.value), id: row.id, companyId: row.company, goalId: row.goal,
      goalVersion: row.goal_version, kind: row.kind, status: row.status, due: row.due, attempt: row.attempt,
      leaseOwner: row.owner, leaseUntil: row.lease_until, checkpoint: row.checkpoint && JSON.parse(row.checkpoint) };
  }

  job(id) { return this.#job(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }

  jobs(company, limit = 100) {
    return this.db.prepare('SELECT * FROM jobs WHERE company=? ORDER BY due DESC LIMIT ?').all(company, limit).map(row => this.#job(row));
  }

  active(company) {
    const states = ACTIVE.map(() => '?').join(',');
    const where = company === undefined ? '' : 'AND company=?';
    return this.db.prepare(`SELECT * FROM jobs WHERE status IN (${states}) ${where} ORDER BY due,id`)
      .all(...ACTIVE, ...(company === undefined ? [] : [company])).map(row => this.#job(row));
  }

  updateJob(job, patch, expectedOwner) {
    const next = { ...job, ...patch };
    const { id, companyId, goalId, goalVersion, kind, status, due, leaseOwner, leaseUntil, attempt, checkpoint, ...value } = next;
    const compare = expectedOwner ? ' AND owner=? AND status=\'running\'' : '';
    const result = this.db.prepare(`UPDATE jobs SET status=?,due=?,value=?,owner=?,lease_until=?,attempt=?,checkpoint=? WHERE id=?${compare}`)
      .run(status, due, JSON.stringify(value), leaseOwner ?? null, leaseUntil ?? null, attempt, checkpoint ? JSON.stringify(checkpoint) : null,
        id, ...(expectedOwner ? [expectedOwner] : []));
    return result.changes ? next : null;
  }

  takeLead(owner, ttl) {
    const now = this.clock();
    return this.db.prepare(`INSERT INTO leader VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
      owner=excluded.owner, expiry=excluded.expiry WHERE leader.owner=excluded.owner OR leader.expiry<=?`)
      .run(owner, now + ttl, now).changes > 0;
  }

  leads(owner) {
    return !!this.db.prepare('SELECT 1 FROM leader WHERE id=1 AND owner=? AND expiry>?').get(owner, this.clock());
  }

  release(owner) { this.db.prepare('DELETE FROM leader WHERE owner=?').run(owner); }

  claim(job, owner, ttl) {
    const now = this.clock();
    if (!this.leads(owner)) return null;
    const changed = this.db.prepare(`UPDATE jobs SET status='running', owner=?, lease_until=?, attempt=attempt+1
      WHERE id=? AND due<=? AND status IN ('queued','retry_scheduled','waiting_dependency')`)
      .run(owner, now + ttl, job.id, now).changes;
    return changed ? this.job(job.id) : null;
  }

  heartbeat(owner, ttl) {
    this.db.prepare("UPDATE jobs SET lease_until=? WHERE owner=? AND status='running' AND lease_until>?")
      .run(this.clock() + ttl, owner, this.clock());
  }

  reserve(job, key, scope, tokens, tool) {
    this.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)')
      .run(job.id, key, job.companyId, scope, this.clock(), tokens, Number(tool));
  }

  totals(company, scope, cutoff) {
    return this.db.prepare(`SELECT coalesce(sum(tokens),0) tokens, coalesce(sum(tool),0) tools,
      count(DISTINCT job) runs FROM usage WHERE company=? AND scope=? AND at>=?`).get(company, scope, cutoff);
  }

  trace(company, trace, type, fields = {}) {
    const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => safeTraceFields.has(key)));
    this.db.prepare('INSERT INTO traces(company,trace,at,type,value) VALUES(?,?,?,?,?)')
      .run(company, trace, this.clock(), type, JSON.stringify(safe));
  }

  activity(company, before = Number.MAX_SAFE_INTEGER, limit = 100) {
    return this.db.prepare('SELECT * FROM traces WHERE company=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(company, before, limit).map(({ value, ...row }) => ({ ...row, ...JSON.parse(value) }));
  }

  close() { this.db.close(); }
}

import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class OrgError extends Error {}
export const taskStatuses = ['todo', 'in_progress', 'waiting', 'finished', 'aborted'];

export function employeeInCompany(data, companyId, botId) {
  const employee = data.employees.find(item => item.botId === botId);
  if (!employee || !data.departments.some(item => item.id === employee.departmentId && item.companyId === companyId)) {
    throw new OrgError('Employee not found in this company.');
  }
  return employee;
}

export function findTask(data, companyId, taskId) {
  findCompany(data, companyId);
  const task = data.tasks.find(item => item.id === taskId && item.companyId === companyId);
  if (!task) throw new OrgError('Task not found in this company.');
  return task;
}

function validateTask(data, task) {
  findCompany(data, task.companyId);
  if (task.ownerId) employeeInCompany(data, task.companyId, task.ownerId);
  if (!taskStatuses.includes(task.status)) throw new OrgError('Unknown task status.');
  if (task.status === 'finished' && (!task.result || !task.evidence)) {
    throw new OrgError('A finished task needs a result and evidence.');
  }
  if (['waiting', 'aborted'].includes(task.status) && !task.reason) {
    throw new OrgError('Explain why this task is waiting or aborted.');
  }
}

export function text(value, label, limit, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || (!value.trim() && !optional) || value.trim().length > limit) {
    throw new OrgError(`${label} must be ${optional ? 'at most' : '1 to'} ${limit} characters.`);
  }
  return value.trim();
}

function sameName(left, right) {
  return left.normalize('NFKC').toLowerCase() === right.normalize('NFKC').toLowerCase();
}

export function findCompany(data, id) {
  const company = data.companies.find(item => item.id === id);
  if (!company) throw new OrgError('Company not found.');
  return company;
}

export function findDepartment(data, companyId, id) {
  const department = data.departments.find(item => item.id === id && item.companyId === companyId);
  if (!department) throw new OrgError('Department not found in this company.');
  return department;
}

export class OrgStore {
  constructor(path) {
    this.path = path;
  }

  read() {
    let source;
    try {
      source = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 2, companies: [], departments: [], employees: [], tasks: [], reportingHistory: [] };
      throw error;
    }
    const data = JSON.parse(source);
    if (![1, 2].includes(data?.version) || !['companies', 'departments', 'employees'].every(key => Array.isArray(data[key]))) {
      throw new Error('Unsupported BotOrgHQ organisation data.');
    }
    if (data.version === 1) {
      data.version = 2;
      data.tasks = [];
      data.reportingHistory = [];
    }
    if (!Array.isArray(data.tasks) || !Array.isArray(data.reportingHistory)) throw new Error('Invalid BotOrgHQ organisation data.');
    return data;
  }

  update(change) {
    const data = this.read();
    const result = change(data);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      if (JSON.parse(readFileSync(this.path, 'utf8')).version === 1) copyFileSync(this.path, `${this.path}.v1-backup`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.path);
    } finally {
      rmSync(temp, { force: true });
    }
    return result;
  }

  createCompany({ name, mission }) {
    const company = { id: randomUUID(), name: text(name, 'Company name', 48), mission: text(mission, 'Company mission', 500, true) };
    return this.update(data => {
      if (data.companies.some(item => sameName(item.name, company.name))) {
        throw new OrgError('A company with this name already exists.');
      }
      data.companies.push(company);
      return company;
    });
  }

  createDepartment({ companyId, name, mission }) {
    const department = {
      id: randomUUID(), companyId, name: text(name, 'Department name', 48),
      mission: text(mission, 'Department mission', 500, true)
    };
    return this.update(data => {
      findCompany(data, companyId);
      if (data.departments.some(item => item.companyId === companyId && sameName(item.name, department.name))) {
        throw new OrgError('A department with this name already exists in this company.');
      }
      data.departments.push(department);
      return department;
    });
  }

  changeReporting({ companyId, employeeId, departmentId, managerId = null }, actorId = 'human') {
    return this.update(data => {
      const employee = employeeInCompany(data, companyId, employeeId);
      findDepartment(data, companyId, departmentId);
      if (managerId !== null && typeof managerId !== 'string') throw new OrgError('Invalid direct manager.');
      let next = managerId;
      const seen = new Set([employeeId]);
      while (next) {
        if (seen.has(next)) throw new OrgError('This reporting relationship would create a cycle.');
        seen.add(next);
        next = employeeInCompany(data, companyId, next).managerId;
      }
      const before = { departmentId: employee.departmentId, managerId: employee.managerId };
      Object.assign(employee, { departmentId, managerId });
      data.reportingHistory.push({ employeeId, companyId, actorId, at: new Date().toISOString(), before, after: { departmentId, managerId } });
      return employee;
    });
  }

  createTask(args, actorId = 'human') {
    return this.update(data => {
      findCompany(data, args.companyId);
      const requestId = text(args.requestId, 'Request ID', 120, true);
      const fields = {
        title: text(args.title, 'Task title', 160), description: text(args.description, 'Description', 8000, true),
        ownerId: args.ownerId || null, expectedResult: text(args.expectedResult, 'Expected result', 4000),
        acceptanceCriteria: text(args.acceptanceCriteria, 'Acceptance criteria', 4000)
      };
      if (requestId) {
        const previous = data.tasks.find(task => task.companyId === args.companyId && task.createdBy === actorId && task.requestId === requestId);
        if (previous) {
          if (Object.entries(fields).some(([key, value]) => value !== previous[key])) throw new OrgError('This request ID already belongs to a different task.');
          return previous;
        }
      }
      const at = new Date().toISOString();
      const task = {
        id: randomUUID(), companyId: args.companyId,
        ...fields,
        status: 'todo', result: '', evidence: '', reason: '', requestId,
        revision: 1, createdAt: at, updatedAt: at, createdBy: actorId,
        history: [{ at, actorId, changes: { status: { before: null, after: 'todo' } } }]
      };
      validateTask(data, task);
      data.tasks.push(task);
      return task;
    });
  }

  updateTask(args, actorId = 'human') {
    return this.update(data => {
      const task = findTask(data, args.companyId, args.taskId);
      if (!Number.isInteger(args.revision) || args.revision !== task.revision) {
        throw new OrgError('This task changed. Reload its latest version before saving.');
      }
      const changes = {};
      const limits = { title: 160, description: 8000, expectedResult: 4000, acceptanceCriteria: 4000, result: 12000, evidence: 12000, reason: 4000 };
      for (const [key, limit] of Object.entries(limits)) {
        if (args[key] !== undefined) {
          const value = text(args[key], key, limit, !['title', 'expectedResult', 'acceptanceCriteria'].includes(key));
          if (value !== task[key]) changes[key] = { before: task[key], after: value };
        }
      }
      for (const key of ['status', 'ownerId']) {
        if (args[key] !== undefined && args[key] !== task[key]) changes[key] = { before: task[key], after: args[key] || null };
      }
      const updated = { ...task, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.after])) };
      validateTask(data, updated);
      if (Object.keys(changes).length) {
        updated.revision++;
        updated.updatedAt = new Date().toISOString();
        updated.history = [...task.history, { at: updated.updatedAt, actorId, changes }];
        Object.assign(task, updated);
      }
      return task;
    });
  }
}

// If an employee was deleted in DS Bot, display the remaining employees under
// the nearest surviving manager. This also keeps the reporting rules usable.
export function reportingEmployees(data, departmentId, botOf) {
  const companyId = data.departments.find(item => item.id === departmentId)?.companyId;
  const departments = new Set(data.departments.filter(item => item.companyId === companyId).map(item => item.id));
  const members = new Map(data.employees.filter(item => departments.has(item.departmentId)).map(item => [item.botId, item]));
  return [...members.values()].filter(item => item.departmentId === departmentId && botOf(item.botId)).map(item => {
    let managerId = item.managerId;
    const visited = new Set([item.botId]);
    while (managerId && members.has(managerId) && !visited.has(managerId)) {
      if (botOf(managerId)) return { ...item, managerId };
      visited.add(managerId);
      managerId = members.get(managerId).managerId;
    }
    return { ...item, managerId: null };
  });
}


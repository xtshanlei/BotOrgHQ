import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class OrgError extends Error {}

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
      if (error.code === 'ENOENT') return { version: 1, companies: [], departments: [], employees: [] };
      throw error;
    }
    const data = JSON.parse(source);
    if (data?.version !== 1 || !['companies', 'departments', 'employees'].every(key => Array.isArray(data[key]))) {
      throw new Error('Unsupported BotOrgHQ organisation data.');
    }
    return data;
  }

  update(change) {
    const data = this.read();
    const result = change(data);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
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
}

// If an employee was deleted in DS Bot, display the remaining employees under
// the nearest surviving manager. This also keeps the reporting rules usable.
export function reportingEmployees(data, departmentId, botOf) {
  const members = new Map(data.employees.filter(item => item.departmentId === departmentId).map(item => [item.botId, item]));
  return [...members.values()].filter(item => botOf(item.botId)).map(item => {
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

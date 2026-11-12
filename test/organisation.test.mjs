import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOrganisation } from '../src/organisation.mjs';
import { OrgStore } from '../src/org-store.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-org-hq-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'organisation.json');
  const store = new OrgStore(path);
  const bots = new Map([['chief', { id: 'chief', name: 'Chief', role: 'Chief of Staff' }]]);
  const dispatched = [];
  const work = {};
  const groupOwners = new Map();
  let nextBot = 0;
  const runtime = {
    state: { mainBotIds: ['chief'] },
    teamTools: [{ name: 'message_bot', execute: (args, exec) => { dispatched.push([args, exec.agent.id]); return 'Queued'; } }],
    addTeamTool(tool) { this.teamTools.push(tool); },
    async load() {},
    readOnly: () => undefined,
    selfOf: id => id,
    groupOwners,
    botOf: id => bots.get(id),
    findBot: name => [...bots.values()].find(bot => bot.name === name),
    isMain: id => id === 'chief',
    chatOf: id => id + '-session',
    workView: () => work,
    approvalsView: () => [],
    waitingView: () => ({}),
    async createBot(options) {
      const bot = { ...options, id: 'employee-' + ++nextBot };
      bots.set(bot.id, bot);
      return bot;
    },
    async deleteBot(id) { bots.delete(id); }
  };
  const organisation = createOrganisation(runtime, store);
  organisation.registerTools();
  const execute = async (name, args, actor = 'chief') => {
    const result = await runtime.teamTools.find(tool => tool.name === name).execute(args, { agent: { id: actor } });
    return result === 'Queued' ? result : JSON.parse(result);
  };
  const hire = (company, department, name, manager) => execute('org_hire', {
    company_id: company.id, department_id: department.id,
    name, role: name, instructions: 'Complete assigned work.',
    ...(manager ? { manager_id: manager.id } : {})
  });
  return { store, path, bots, runtime, work, dispatched, organisation, execute, hire };
}

test('Chief hires native employee Bots into a persisted three-level department tree', async t => {
  const { execute, hire, work, organisation, path } = fixture(t);
  const company = await execute('org_create_company', { name: 'Research Co' });
  const department = await execute('org_create_department', { company_id: company.id, name: 'Evidence' });
  const lead = await hire(company, department, 'Director');
  const manager = await hire(company, department, 'Manager', lead);
  const worker = await hire(company, department, 'Analyst', manager);
  work[worker.id] = { tool: 'read_file' };
  const [chart] = organisation.snapshot().companies[0].departments;
  assert.deepEqual(chart.employees.map(({ id, managerId }) => [id, managerId]),
    [[lead.id, null], [manager.id, lead.id], [worker.id, manager.id]]);
  assert.equal(chart.employees[2].status, 'working');
  assert.equal(chart.employees[2].tool, 'read_file');
  assert.equal(chart.employees[2].sessionId, worker.id + '-session');
  assert.equal(new OrgStore(path).read().employees.length, 3);
});

test('Department placement and native task handoffs respect company and reporting scope', async t => {
  const { store, execute, hire, dispatched, organisation } = fixture(t);
  const company = store.createCompany({ name: 'Research Co' });
  const second = store.createCompany({ name: 'Product Co' });
  const department = store.createDepartment({ companyId: company.id, name: 'Research' });
  const other = store.createDepartment({ companyId: second.id, name: 'Research' });
  const lead = await hire(company, department, 'Research Lead');
  const worker = await hire(company, department, 'Researcher', lead);
  const otherLead = await hire(second, other, 'Product Lead');
  await assert.rejects(hire(second, other, 'Wrong manager', lead), /not found in this company/);
  await assert.rejects(hire(second, department, 'Wrong company'), /not found in this company/);
  await assert.rejects(execute('org_create_company', { name: 'Unauthorised' }, lead.id), /Only a Chief/);
  await assert.rejects(execute('org_list', { company_id: second.id }, worker.id), /outside your scope/);
  const task = { company_id: company.id, department_id: department.id, employee_id: worker.id, task: 'Review the evidence.', request_id: 'evidence-review' };
  await assert.rejects(execute('org_delegate', task, worker.id), /direct reports/);
  await assert.rejects(execute('org_delegate', { ...task, company_id: second.id }, 'chief'), /not found in this company/);
  const handoff = await execute('org_delegate', task, lead.id);
  assert.equal(handoff.receipt, 'Queued');
  assert.equal(dispatched[0][0].to, 'Researcher');
  assert.match(dispatched[0][0].message, new RegExp(handoff.taskId));
  assert.equal(dispatched[0][0].request_id, `org-task-${handoff.taskId}`);
  assert.equal(dispatched[0][1], lead.id);
  assert.equal(store.read().tasks[0].ownerId, worker.id);
  const message = (sender, target) => organisation.guardMessage({ name: 'message_bot', agent: { id: sender.id }, arguments: { to: target.name } });
  assert.match(message(lead, otherLead), /outside your BotOrgHQ company/);
  assert.equal(message(lead, worker), undefined);
});

test('Version 1 migration preserves every existing organisation field and keeps an original backup', t => {
  const { path, store } = fixture(t);
  const legacy = { version: 1, companies: [{ id: 'co', name: 'Existing' }], departments: [{ id: 'dep', companyId: 'co', name: 'Original' }],
    employees: [{ botId: 'old-bot', departmentId: 'dep', managerId: null }], extra: { kept: true } };
  const bytes = JSON.stringify(legacy);
  writeFileSync(path, bytes);
  assert.equal(store.read().version, 2);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  store.createDepartment({ companyId: 'co', name: 'New' });
  assert.equal(readFileSync(`${path}.v1-backup`, 'utf8'), bytes);
  const reopened = new OrgStore(path).read();
  assert.deepEqual(reopened.employees, legacy.employees);
  assert.deepEqual(reopened.companies, legacy.companies);
  assert.deepEqual(reopened.extra, legacy.extra);
});

test('Cross-department reporting is visible, keeps company scope and rejects cycles', async t => {
  const { store, hire, execute, organisation } = fixture(t);
  const company = store.createCompany({ name: 'Company' });
  const research = store.createDepartment({ companyId: company.id, name: 'Research' });
  const product = store.createDepartment({ companyId: company.id, name: 'Product' });
  const director = await hire(company, research, 'Director');
  const analyst = await hire(company, product, 'Analyst', director);
  assert.equal(organisation.snapshot().companies[0].departments[1].employees[0].managerId, director.id);
  await execute('org_create_department', { company_id: company.id, name: 'Evidence' }, analyst.id);
  await assert.rejects(execute('org_change_reporting', { company_id: company.id, employee_id: director.id, department_id: research.id, manager_id: analyst.id }), /cycle/);
  await assert.rejects(execute('org_change_reporting', { company_id: company.id, employee_id: director.id, department_id: product.id }, analyst.id), /current direct manager/);
  await execute('org_change_reporting', { company_id: company.id, employee_id: analyst.id, department_id: research.id, manager_id: director.id }, director.id);
  assert.equal(store.read().reportingHistory.length, 1);
  assert.equal(store.read().employees[1].departmentId, research.id);
});

test('Company task boards enforce ownership, evidence, retry identity and optimistic concurrency', async t => {
  const { store, hire, execute, path } = fixture(t);
  const company = store.createCompany({ name: 'Company' });
  const other = store.createCompany({ name: 'Other' });
  const department = store.createDepartment({ companyId: company.id, name: 'Evidence' });
  const lead = await hire(company, department, 'Lead');
  const analyst = await hire(company, department, 'Analyst', lead);
  const args = { company_id: company.id, title: 'Review', owner_id: analyst.id, expected_result: 'Report', acceptance_criteria: 'Cite sources', request_id: 'review-1' };
  const task = await execute('org_task_create', args, lead.id);
  assert.equal((await execute('org_task_create', args, lead.id)).id, task.id);
  await assert.rejects(execute('org_task_create', { ...args, title: 'Different' }, lead.id), /different task/);
  await assert.rejects(execute('org_task_list', { company_id: other.id }, analyst.id), /not found in this company/);
  await assert.rejects(execute('org_task_update', { company_id: company.id, task_id: task.id, revision: 1, status: 'finished' }, analyst.id), /result and evidence/);
  await execute('org_task_update', { company_id: company.id, task_id: task.id, revision: 1, status: 'in_progress' }, analyst.id);
  await assert.rejects(execute('org_task_update', { company_id: company.id, task_id: task.id, revision: 1, status: 'aborted', reason: 'Old update' }, analyst.id), /changed/);
  await assert.rejects(execute('org_task_update', { company_id: company.id, task_id: task.id, revision: 2, status: 'waiting' }, analyst.id), /Explain why/);
  const done = await execute('org_task_update', { company_id: company.id, task_id: task.id, revision: 2, status: 'finished', result: 'Delivered report', evidence: 'report.md with source references' }, analyst.id);
  assert.equal(done.revision, 3);
  assert.equal(done.history.length, 3);
  assert.deepEqual(new OrgStore(path).read().tasks[0], done);
  assert.equal((await execute('org_task_list', { company_id: company.id }, lead.id))[0].status, 'finished');
});

test('A simultaneous department-head hire keeps one native Bot and one reporting root', async t => {
  const { store, bots, hire } = fixture(t);
  const company = store.createCompany({ name: 'Research Co' });
  const department = store.createDepartment({ companyId: company.id, name: 'Evidence' });
  const results = await Promise.allSettled([hire(company, department, 'First'), hire(company, department, 'Second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(store.read().employees.length, 1);
  assert.deepEqual([...bots.keys()], ['chief', store.read().employees[0].botId]);
});

test('Deleting a manager in the upstream roster keeps the employee under a surviving manager', async t => {
  const { store, bots, hire, organisation } = fixture(t);
  const company = store.createCompany({ name: 'Research Co' });
  const department = store.createDepartment({ companyId: company.id, name: 'Evidence' });
  const lead = await hire(company, department, 'Director');
  const manager = await hire(company, department, 'Manager', lead);
  const worker = await hire(company, department, 'Analyst', manager);
  bots.delete(manager.id);
  const chart = organisation.snapshot().companies[0].departments[0].employees;
  assert.deepEqual(chart.map(({ id, managerId }) => [id, managerId]), [[lead.id, null], [worker.id, lead.id]]);
});


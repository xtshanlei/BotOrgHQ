import { defineTool } from '@deepseek-ai/dsh-tools';
import { findCompany, findDepartment, OrgError, reportingEmployees, text } from './org-store.mjs';

const parameter = (description, required = true) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

export function createOrganisation(runtime, store) {
  const botOf = id => runtime.botOf(id);
  const membersOf = (data, department) => reportingEmployees(data, department.id, botOf);

  function writable() {
    const message = runtime.readOnly();
    if (message) throw new OrgError(message);
  }

  function actorOf(exec) {
    const sessionId = exec.agent?.id;
    const bot = botOf(runtime.selfOf(sessionId));
    if (!bot || runtime.groupOwners.has(sessionId)) {
      throw new OrgError('Use organisation tools from a Bot’s own chat.');
    }
    return bot;
  }

  function chief(actor) {
    if (!runtime.isMain(actor.id)) throw new OrgError('Only a Chief can make this change.');
  }

  function describe(bot, work, approvals, waiting) {
    const status = approvals.has(bot.id) ? 'approval'
      : work[bot.id] ? 'working'
      : bot.blocked ? 'blocked'
      : waiting[bot.id] ? 'waiting'
      : 'idle';
    return { id: bot.id, name: bot.name, role: bot.role, sessionId: runtime.chatOf(bot.id), status, tool: work[bot.id]?.tool };
  }

  function snapshot() {
    const data = store.read();
    const work = runtime.workView();
    const approvals = new Set(runtime.approvalsView().map(item => item.botId));
    const waiting = runtime.waitingView();
    const view = bot => describe(bot, work, approvals, waiting);
    return {
      chief: runtime.state.mainBotIds.map(botOf).filter(Boolean).map(view)[0] ?? null,
      readOnly: runtime.readOnly() ?? null,
      companies: data.companies.map(company => ({
        ...company,
        departments: data.departments.filter(item => item.companyId === company.id).map(department => ({
          ...department,
          employees: membersOf(data, department).map(member => ({ ...view(botOf(member.botId)), managerId: member.managerId }))
        }))
      }))
    };
  }

  function placement(data, companyId, departmentId, managerId) {
    findCompany(data, companyId);
    const department = findDepartment(data, companyId, departmentId);
    const members = membersOf(data, department);
    if (managerId && !members.some(item => item.botId === managerId)) {
      throw new OrgError('Select a manager from the same department.');
    }
    if (!managerId && members.length) throw new OrgError('This department already has employees. Specify their new colleague’s direct manager.');
    return department;
  }

  async function hire(actor, args) {
    chief(actor);
    writable();
    const managerId = args.manager_id?.trim() || null;
    const department = placement(store.read(), args.company_id, args.department_id, managerId);
    const bot = await runtime.createBot({
      name: text(args.name, 'Employee name', 40),
      role: text(args.role, 'Employee role', 24),
      instructions: text(args.instructions, 'Employee instructions', 2000),
      createdBy: actor.id
    });
    try {
      writable();
      store.update(data => {
        placement(data, args.company_id, department.id, managerId);
        data.employees.push({ botId: bot.id, departmentId: department.id, managerId });
      });
    } catch (error) {
      try {
        await runtime.deleteBot(bot.id);
      } catch (rollbackError) {
        runtime.warn('BotOrgHQ: could not roll back the unassigned Bot %s: %s', bot.id, rollbackError);
        throw new OrgError('The Bot session was created, but saving its department failed. Review unassigned Bots in Bot mode before retrying.');
      }
      throw error;
    }
    return { id: bot.id, name: bot.name, departmentId: department.id, managerId };
  }

  function targetOf(actor, args) {
    const data = store.read();
    const department = findDepartment(data, args.company_id, args.department_id);
    const target = membersOf(data, department).find(item => item.botId === args.employee_id);
    if (!target) throw new OrgError('Employee not found in this department.');
    if (!runtime.isMain(actor.id) && target.managerId !== actor.id) {
      throw new OrgError('Employees can delegate only to their direct reports.');
    }
    return botOf(target.botId);
  }

  function modelView(actor, companyId) {
    const data = store.read();
    const ownDepartment = data.departments.find(department => data.employees.some(employee =>
      employee.botId === actor.id && employee.departmentId === department.id));
    const permitted = runtime.isMain(actor.id) ? data.companies
      : data.companies.filter(company => company.id === ownDepartment?.companyId);
    if (companyId && !permitted.some(company => company.id === companyId)) {
      throw new OrgError('Company not found or outside your scope.');
    }
    return permitted.filter(company => !companyId || company.id === companyId).map(company => ({
      ...company,
      departments: data.departments.filter(item => item.companyId === company.id).map(department => ({
        ...department,
        employees: membersOf(data, department).map(({ botId, managerId }) => {
          const bot = botOf(botId);
          return { id: botId, name: bot.name, role: bot.role, managerId };
        })
      }))
    }));
  }

  function registerTools() {
    const send = runtime.teamTools.find(tool => tool.name === 'message_bot');
    if (!send) throw new Error('The pinned DS Bot runtime does not provide message_bot.');
    const register = (name, description, parameters, execute) => {
      runtime.addTeamTool(defineTool({
        name, description, parameters, output,
        async execute(args, exec) {
          await runtime.load();
          const value = await execute(actorOf(exec), args, exec);
          return typeof value === 'string' ? value : JSON.stringify(value);
        }
      }));
    };

    register('org_list', 'List BotOrgHQ companies, departments and employee IDs with their direct managers. Use these IDs in organisation tools.', {
      company_id: parameter('Company ID. Omit to list all companies you can see.', false)
    }, (actor, args) => modelView(actor, args.company_id));

    register('org_create_company', 'Chief only. Create a company in BotOrgHQ.', {
      name: parameter('Company name'), mission: parameter('Company mission', false)
    }, (actor, args) => {
      chief(actor);
      writable();
      return store.createCompany(args);
    });

    register('org_create_department', 'Chief only. Add a department to a company in BotOrgHQ.', {
      company_id: parameter('Company ID from org_list or org_create_company'),
      name: parameter('Department name'), mission: parameter('Department mission', false)
    }, (actor, { company_id: companyId, ...args }) => {
      chief(actor);
      writable();
      return store.createDepartment({ companyId, ...args });
    });

    register('org_hire', 'Chief only. Create a native employee Bot in a department. Hire the department lead first, then use the lead or another employee ID as direct manager.', {
      company_id: parameter('Company ID'), department_id: parameter('Department ID'),
      manager_id: parameter('Direct manager ID in this department. Omit for the first employee only.', false),
      name: parameter('A distinct Bot name across the profile, up to 40 characters'),
      role: parameter('Job title, up to 24 characters'),
      instructions: parameter('Employee’s standing responsibilities, up to 2000 characters')
    }, hire);

    register('org_delegate', 'Assign a task through DS Bot’s native handoff. The Chief can assign within the named company. Other Bots can assign only to their own direct reports. The result returns to this chat.', {
      company_id: parameter('Company ID'), department_id: parameter('Department ID'),
      employee_id: parameter('Employee ID'), task: parameter('Self-contained task and expected result'),
      request_id: parameter('Stable name for this request so a retry does not send twice', false)
    }, (actor, args, exec) => {
      writable();
      const target = targetOf(actor, args);
      return send.execute({
        to: target.name, message: text(args.task, 'Task', 4000), when: 'queue',
        ...(args.request_id ? { request_id: args.request_id } : {})
      }, exec);
    });
  }

  function prompt(sessionId) {
    const bot = botOf(runtime.selfOf(sessionId));
    if (!bot) return '';
    if (runtime.isMain(bot.id)) return 'You also manage BotOrgHQ. For company work use org_list, org_create_company, org_create_department, org_hire and org_delegate. Resolve the intended company explicitly. Hire a department lead before its reports. A request to hire into a company or department should use org_hire, which records the reporting relationship.';
    return 'For assignments to direct reports in BotOrgHQ, use org_list and org_delegate from your own chat. Keep company work in its own company.';
  }

  function guardMessage(exec) {
    if (exec.name !== 'message_bot' || typeof exec.arguments?.to !== 'string') return;
    const sender = botOf(runtime.selfOf(exec.agent?.id));
    const target = runtime.findBot(exec.arguments.to);
    if (!sender || !target || runtime.isMain(sender.id) || runtime.isMain(target.id)) return;
    const data = store.read();
    const companyOf = botId => {
      const membership = data.employees.find(employee => employee.botId === botId);
      return data.departments.find(department => department.id === membership?.departmentId)?.companyId;
    };
    if (companyOf(sender.id) !== companyOf(target.id)) return 'This Bot is outside your BotOrgHQ company.';
  }

  return { snapshot, registerTools, prompt, guardMessage, writable };
}

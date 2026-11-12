import { defineTool } from '@deepseek-ai/dsh-tools';
import { employeeInCompany, findCompany, findDepartment, findTask, OrgError, reportingEmployees, text } from './org-store.mjs';

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
        tasks: data.tasks.filter(task => task.companyId === company.id),
        departments: data.departments.filter(item => item.companyId === company.id).map(department => ({
          ...department,
          employees: membersOf(data, department).map(member => ({ ...view(botOf(member.botId)), managerId: member.managerId, departmentId: department.id }))
        }))
      }))
    };
  }

  function placement(data, companyId, departmentId, managerId) {
    findCompany(data, companyId);
    const department = findDepartment(data, companyId, departmentId);
    const members = membersOf(data, department);
    if (managerId) employeeInCompany(data, companyId, managerId);
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
      tasks: data.tasks.filter(task => task.companyId === company.id),
      departments: data.departments.filter(item => item.companyId === company.id).map(department => ({
        ...department,
        employees: membersOf(data, department).map(({ botId, managerId }) => {
          const bot = botOf(botId);
          return { id: botId, name: bot.name, role: bot.role, managerId };
        })
      }))
    }));
  }

  function permitCompany(actor, companyId) {
    findCompany(store.read(), companyId);
    if (!runtime.isMain(actor.id)) employeeInCompany(store.read(), companyId, actor.id);
  }

  function permitOwner(actor, companyId, ownerId) {
    permitCompany(actor, companyId);
    if (!ownerId) {
      chief(actor);
      return;
    }
    const owner = employeeInCompany(store.read(), companyId, ownerId);
    if (!runtime.isMain(actor.id) && !botOf(ownerId)) throw new OrgError('The task owner is no longer in the Bot roster.');
    if (!runtime.isMain(actor.id) && ownerId !== actor.id && owner.managerId !== actor.id) {
      throw new OrgError('You can change tasks only for yourself or your direct reports.');
    }
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

    register('org_create_department', 'Add a department to your company. The Chief can add departments to any company.', {
      company_id: parameter('Company ID from org_list or org_create_company'),
      name: parameter('Department name'), mission: parameter('Department mission', false)
    }, (actor, { company_id: companyId, ...args }) => {
      permitCompany(actor, companyId);
      writable();
      return store.createDepartment({ companyId, ...args });
    });

    register('org_hire', 'Chief only. Create a native employee Bot in a department. Hire the department lead first, then use the lead or another employee ID as direct manager.', {
      company_id: parameter('Company ID'), department_id: parameter('Department ID'),
      manager_id: parameter('Direct manager ID anywhere in this company, including another department. Omit for the first employee only.', false),
      name: parameter('A distinct Bot name across the profile, up to 40 characters'),
      role: parameter('Job title, up to 24 characters'),
      instructions: parameter('Employee’s standing responsibilities, up to 2000 characters')
    }, hire);

    register('org_change_reporting', 'Change an employee department and direct manager within the same company. Cross-department managers are supported. The Chief or current direct manager can make changes. Cycles are rejected.', {
      company_id: parameter('Company ID'), employee_id: parameter('Employee ID'),
      department_id: parameter('New or existing department ID'), manager_id: parameter('Direct manager ID within the company. Empty means reports to the Chief.', false)
    }, (actor, args) => {
      writable();
      const employee = employeeInCompany(store.read(), args.company_id, args.employee_id);
      if (!runtime.isMain(actor.id) && employee.managerId !== actor.id) throw new OrgError('Only the Chief or current direct manager can change reporting.');
      if (args.manager_id && !botOf(args.manager_id)) throw new OrgError('The manager no longer exists.');
      return store.changeReporting({ companyId: args.company_id, employeeId: args.employee_id, departmentId: args.department_id, managerId: args.manager_id || null }, actor.id);
    });

    register('org_task_list', 'Read the company task board, including owners, statuses, required outcomes, acceptance criteria, evidence and change history. All employees can read their own company board.', {
      company_id: parameter('Company ID')
    }, (actor, args) => {
      permitCompany(actor, args.company_id);
      return store.read().tasks.filter(task => task.companyId === args.company_id);
    });

    register('org_task_create', 'Create a to-do task on the company board. Assign yourself or a direct report. Chief may assign any employee or leave it unassigned. Creating a card does not send a message. Use org_delegate to dispatch work.', {
      company_id: parameter('Company ID'), title: parameter('Task title'), description: parameter('Task instructions', false),
      owner_id: parameter('Employee ID, or omit for unassigned (Chief only)', false),
      expected_result: parameter('Concrete deliverable'), acceptance_criteria: parameter('How the result will be accepted'),
      request_id: parameter('Stable request name for safe retries', false)
    }, (actor, args) => {
      writable();
      permitOwner(actor, args.company_id, args.owner_id);
      return store.createTask({ companyId: args.company_id, title: args.title, description: args.description, ownerId: args.owner_id,
        expectedResult: args.expected_result, acceptanceCriteria: args.acceptance_criteria, requestId: args.request_id }, actor.id);
    });

    register('org_task_update', 'Update your task or a direct report task. Read the board first and supply its revision. Finished requires a result and concrete evidence. Waiting or aborted requires a reason. Never claim evidence you have not obtained.', {
      company_id: parameter('Company ID'), task_id: parameter('Task ID'),
      revision: { type: 'number', required: true, description: 'Current revision from org_task_list' },
      status: parameter('todo, in_progress, waiting, finished or aborted', false),
      owner_id: parameter('New owner, omit to retain, empty to unassign (Chief only)', false),
      result: parameter('Actual deliverable or result', false), evidence: parameter('Evidence references and what each proves', false),
      reason: parameter('Reason for waiting or aborting', false)
    }, (actor, args) => {
      writable();
      const task = findTask(store.read(), args.company_id, args.task_id);
      permitOwner(actor, args.company_id, task.ownerId);
      if (args.owner_id !== undefined) permitOwner(actor, args.company_id, args.owner_id);
      return store.updateTask({ companyId: args.company_id, taskId: args.task_id, revision: args.revision,
        status: args.status, ownerId: args.owner_id, result: args.result, evidence: args.evidence, reason: args.reason }, actor.id);
    });

    register('org_delegate', 'Create or reuse a task board card and dispatch it through DS Bot handoff. Chief can assign within a company. Employees can assign only to direct reports. The recipient must update the board with result and evidence.', {
      company_id: parameter('Company ID'), department_id: parameter('Department ID'),
      employee_id: parameter('Employee ID'), task: parameter('Self-contained task and expected result'),
      request_id: parameter('Stable name for this request so a retry does not send twice', false),
      expected_result: parameter('Expected deliverable, defaults to task instructions', false),
      acceptance_criteria: parameter('Acceptance criteria', false)
    }, async (actor, args, exec) => {
      writable();
      const target = targetOf(actor, args);
      const instruction = text(args.task, 'Task', 4000);
      const task = store.createTask({ companyId: args.company_id, title: instruction.slice(0, 160), description: instruction,
        ownerId: target.id, expectedResult: args.expected_result || instruction,
        acceptanceCriteria: args.acceptance_criteria || 'Deliver the requested result with verifiable evidence.', requestId: args.request_id }, actor.id);
      const receipt = await send.execute({
        to: target.name, message: `${instruction}\n\nBotOrgHQ task ${task.id} in company ${task.companyId}. Read org_task_list, set in_progress when starting, and update the board with the result and evidence before finishing. Expected result: ${task.expectedResult}\nAcceptance criteria: ${task.acceptanceCriteria}`, when: 'queue',
        request_id: `org-task-${task.id}`
      }, exec);
      return { taskId: task.id, receipt };
    });
  }

  function prompt(sessionId) {
    const bot = botOf(runtime.selfOf(sessionId));
    if (!bot) return '';
    const companies = modelView(bot);
    const boards = companies.map(company => ({ id: company.id, name: company.name,
      tasks: company.tasks.filter(task => !['finished', 'aborted'].includes(task.status)).map(task => ({ id: task.id, title: task.title, ownerId: task.ownerId, status: task.status, revision: task.revision })) }));
    return `${runtime.isMain(bot.id) ? 'You manage BotOrgHQ companies. Use org_create_company, org_create_department, org_hire and org_change_reporting to maintain the organisation.' : 'You can read your whole company board. Use org_create_department to add a department in your company. Use org_change_reporting for your direct reports.'} Use org_list for organisation IDs and org_task_list for full task descriptions, outcomes, acceptance criteria, evidence and history. Read your assigned to-do cards, set in_progress when you begin, waiting with a reason when blocked, finished only with the actual result and evidence, or aborted with a reason. Use org_delegate for assignments to direct reports. Company boards are shared working context. Current boards: ${JSON.stringify(boards)}`;
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


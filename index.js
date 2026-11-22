import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntime, inject } from 'ds-bot';
import { createOrganisation } from './src/organisation.mjs';
import { OrgError, OrgStore } from './src/org-store.mjs';
import { installProactive } from './src/proactive/integration.mjs';

export { inject };
export const name = 'bot-org-hq';

export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME?.trim().replace(/^~(?=[/\\]|$)/, homedir()) || join(homedir(), '.dsh');
  const home = resolve(config.home ?? join(dshHome, 'bot-org-hq'));
  const runtime = createRuntime(ctx, { ...config, home, updateCheck: false });
  const store = new OrgStore(join(home, 'organisation.json'));
  const organisation = createOrganisation(runtime, store);
  organisation.registerTools();
  const proactive = installProactive(ctx, home, dshHome, runtime, organisation);
  ctx.effect(() => ctx.tools.guard(organisation.guardMessage), 'BotOrgHQ direct message scope');

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bot-org-hq:organisation',
    order: 641,
    interpolate: false,
    text: context => organisation.prompt(context?.agent?.id)
  }), 'BotOrgHQ organisation instructions');

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bot-org-hq',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const respond = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        return respond({ error: 'Expected a JSON request.' }, 415);
      }
      const input = await request.json().catch(() => null);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return respond({ error: 'Expected a JSON object.' }, 400);
      }
      try {
        await runtime.refresh();
        if (typeof input.action === 'string' && input.action.startsWith('proactive:')) {
          const origin = request.headers.get('origin');
          if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(request.url).origin)) {
            return respond({ error: 'Same-origin DSH owner connection required.' }, 403);
          }
          if (input.action !== 'proactive:list' && !input.value && input.action !== 'proactive:export-traces') throw new OrgError('Missing action value.');
          return respond({ value: proactive.action(input) });
        }
        switch (input.action) {
          case 'state':
            if (!runtime.readOnly() && !runtime.state.mainBotIds.length) await runtime.bootstrap();
            {
              const value = organisation.snapshot();
              for (const company of value.companies) {
                company.tasks.push(...proactive.projectTasks(company.id));
                const states = proactive.employeeState(company.id);
                for (const department of company.departments) for (const employee of department.employees) employee.proactive = states[employee.id];
              }
              return respond({ value });
            }
          case 'create-company':
            organisation.writable();
            return respond({ value: store.createCompany(input) }, 201);
          case 'create-department':
            organisation.writable();
            return respond({ value: store.createDepartment(input) }, 201);
          case 'change-reporting':
            organisation.writable();
            if (input.managerId && !runtime.botOf(input.managerId)) throw new OrgError('The selected manager no longer exists.');
            if (!runtime.botOf(input.employeeId)) throw new OrgError('The employee no longer exists.');
            return respond({ value: store.changeReporting(input) });
          case 'create-task':
            organisation.writable();
            if (input.ownerId && !runtime.botOf(input.ownerId)) throw new OrgError('The selected owner no longer exists.');
            return respond({ value: store.createTask(input) }, 201);
          case 'update-task':
            organisation.writable();
            return respond({ value: store.updateTask(input) });
          default:
            return respond({ error: 'Unknown BotOrgHQ action.' }, 400);
        }
      } catch (error) {
        if (error instanceof OrgError) return respond({ error: error.message }, 400);
        runtime.warn('BotOrgHQ: %s failed: %s', input.action, error);
        return respond({ error: 'BotOrgHQ could not complete the request. Check the DSH host log.' }, 500);
      }
    }
  }), 'BotOrgHQ API');
}


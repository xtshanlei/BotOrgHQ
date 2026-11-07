# Upstream feature map

BotOrgHQ uses a company-scoped domain model for managers, employees and work. Its first implementation is original source. The projects below are the reference implementations for subsequent adapters.

| Project | Licence | Reference snapshot |
| --- | --- | --- |
| [DS Bot](https://github.com/Fei2411/DS-Bot) | [Apache-2.0](https://github.com/Fei2411/DS-Bot/blob/6559c9e7c4ef71c292e6ac50f690031133536fe0/LICENSE) | [6559c9e · v0.3.1](https://github.com/Fei2411/DS-Bot/commit/6559c9e7c4ef71c292e6ac50f690031133536fe0) |
| [Tobs / DeepSeekBot](https://github.com/BotHarness/DeepSeekBot) | [MIT](https://github.com/BotHarness/DeepSeekBot/blob/172d5ae255b4d6932175df64a669901ac4ee64d5/LICENSE) | [172d5ae](https://github.com/BotHarness/DeepSeekBot/commit/172d5ae255b4d6932175df64a669901ac4ee64d5) |

Record the upstream path and revision for reused code. Preserve the applicable copyright and licence notices, including DS Bot's [NOTICE](https://github.com/Fei2411/DS-Bot/blob/6559c9e7c4ef71c292e6ac50f690031133536fe0/NOTICE) if its code is incorporated. Select the licence for original BotOrgHQ code when preparing the public release.

## Feature milestones

| Milestone | Scope | Acceptance |
| --- | --- | --- |
| M0 · Company operations | Company boundaries, multi-level hiring, direct-report delegation, persistent text jobs and the animated chart | The Chief hires a lead and an employee who reports to that lead. The lead and employee show as working in sequence. A second company has an independent roster, history and event stream. |
| M1 · DeepSeek Harness and DS Bot collaboration | Add a native DSH runtime, stable per-bot sessions, direct conversations and group chat, including mentions and handoff results | Run a DSH-backed handoff end to end. Map real session lifecycle events to the chart. Verify approval and failure paths, and ensure workspace and model contexts are company scoped. |
| M2 · Tobs identity and memory | Bot personas, per-bot Git memory, reviewable diffs and rollback, scheduler and audit controls | A memory edit can be reviewed and reverted. A scheduled run fires within its company and appears in that company's activity. |
| M3 · Capabilities and channels | Company-scoped skills and MCP grants, IM identities, connectors and bot templates | Per-company credentials and grants are enforced at tool execution. Importing a template creates a new bot under an explicitly chosen manager. Test each transport against the upstream feature checklist. |

DS Bot's [roster](https://github.com/Fei2411/DS-Bot/blob/6559c9e7c4ef71c292e6ac50f690031133536fe0/ds-bot/src/host/roster.js), [handoffs](https://github.com/Fei2411/DS-Bot/blob/6559c9e7c4ef71c292e6ac50f690031133536fe0/ds-bot/src/host/handoffs.js), [group routing](https://github.com/Fei2411/DS-Bot/blob/6559c9e7c4ef71c292e6ac50f690031133536fe0/ds-bot/src/host/groups.js) and [turn tracking](https://github.com/Fei2411/DS-Bot/blob/6559c9e7c4ef71c292e6ac50f690031133536fe0/ds-bot/src/host/turns.js) are the starting points for M1. Tobs' [core package](https://github.com/BotHarness/DeepSeekBot/tree/172d5ae255b4d6932175df64a669901ac4ee64d5/packages/core/src) separates memory, identities, channels, scheduling and marketplace code.

## Runtime boundary

`src/runtime.mjs` owns job transitions and commits model decisions through `src/plan.mjs` and `src/store.mjs`. An engine implements `plan` for the Chief and `execute` for an employee. A future DSH adapter should bind a company and bot to a native session and translate the session lifecycle into job transitions. Compare the official [CLI profiles](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) against the workspace, tool and credential isolation required here.

The current HTTP service is for a single local owner. Hosted use requires authentication, authorisation and isolated agent workspaces before enabling tools or integrations. A separate SQLite database keeps demo records out of the model workspace.

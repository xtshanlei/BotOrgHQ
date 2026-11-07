# BotOrgHQ

A native DeepSeek Harness plugin for managing companies and their Bot employees. Select a company to see its departments. Open a department to see who reports to whom and which Bots are working. Click an employee to open their Harness conversation.

## Desktop app

BotOrgHQ Desktop ships an Electron window, a private Node runtime, DeepSeek Harness, and the BotOrgHQ plugin in one package. It starts DSH on an authenticated local port and opens the workspace in a desktop window. Select BotOrgHQ in the sidebar to view company and department charts. The desktop app uses its own data directory under the operating system's application-data location. Set up your model from inside the app.

Build on the operating system and architecture you want to package. Use Node.js 24.9 or later and npm on the build machine.

```sh
npm ci
npm --prefix desktop ci
npm --prefix desktop run dist
```

Packages go to `desktop/dist/`. The configured targets are a per-user NSIS installer on Windows, an ad-hoc-signed ZIP on macOS, and a Debian package on Linux. For a development launch, run `npm --prefix desktop run prepare-runtime` followed by `npm --prefix desktop start`.

## Install in an existing DSH

The plugin targets **DeepSeek Harness 0.2.2-rc.1**. The install and department workflow were tested in the DSH Web profile. Building the package requires Node.js 24.9 or newer.

```sh
npm ci
npm pack
```

In DSH Desktop, open **Plugins → Add plugin** and enter the absolute path of the generated `bot-org-hq-0.2.0.tgz`. Enable it and open **BotOrgHQ** from the sidebar.

For DSH Web, run these commands from the checkout using a separate DSH CLI installation. The DSH CLI needs pnpm on PATH.

```sh
dsh plugin --profile web add ./bot-org-hq-0.2.0.tgz
dsh web
```

BotOrgHQ bundles the DS Bot host and UI. If the same profile already runs the original DS Bot plugin, disable its entry in that profile before enabling BotOrgHQ. Each plugin has its own data directory. Existing BotOrgHQ v0.1 SQLite records and existing DS Bot rosters need a separate migration to appear in this version's departments.

## Create a company

You can create companies and departments from the BotOrgHQ panel. **打开集团 Chief** opens the Chief's native conversation. Select a model configured in DSH and describe the organisation or assignment you want.

> 建立「研究工作室」，设立「研究部」和「出版部」。为研究部创建研究主管，让分析师向研究主管汇报。请研究主管制定验收标准，再把整理证据的工作交给分析师。

Chief uses `org_list`, `org_create_company`, `org_create_department`, `org_hire` and `org_delegate`. The first hire in a department becomes its lead. Later hires need a manager in the same department. The Chief can assign work within the specified company. Employees can use organisation assignments for their direct reports. Results return through the upstream Bot handoff.

The company view shows live counts by department. The department view shows the reporting tree, work status and active tool when available. The panel reads native DS Bot activity about once per second and highlights the reporting path to a working employee.

## Runtime and data

The plugin runs in the DSH host and uses its model settings, credentials and owner-authenticated connection. BotOrgHQ stores the company structure under `$DSH_HOME/bot-org-hq`. Its pinned DS Bot runtime provides Bot sessions, handoffs and the original Bot UI for chat, group chat and memory. Organisation queries and handoffs enforce their company and manager scope. The underlying DS Bot profile still has its shared team memory and other team-wide settings.

```sh
npm test
```

See the [upstream integration notes](docs/upstream.md) for attribution and current coverage.

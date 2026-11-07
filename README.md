# BotOrgHQ

**One Chief, multiple AI companies, visible lines of responsibility.**

BotOrgHQ is a local operations console for teams of long-lived AI employees. Create a company and give the Chief a goal. The Chief can hire bots, define their roles, set direct managers and assign work. A manager can delegate to its direct reports. The company chart shows each employee's live workload and lets you inspect their assignments and results.

## Quick start

Use Node.js 24 or later. The app has zero package dependencies.

```sh
npm start
```

Open [http://127.0.0.1:3030](http://127.0.0.1:3030). In **演示模式**, select either sample company and click **运行演示**. Watch the Chief hire a delivery lead and specialist. The lead defines the acceptance criteria and then delegates to the specialist. Click a bot card to see who assigned its task and what it produced.

For real model execution, copy `.env.example` to `.env`, set `DEEPSEEK_API_KEY` and restart. The default model is `deepseek-flash`. You can set `DEEPSEEK_MODEL` and `PORT` in the same file.

```sh
cp .env.example .env
# Set DEEPSEEK_API_KEY in .env before starting the app.
npm start
```

The DeepSeek mode starts with a separate, empty workspace. Create a company, then try this goal in its Chief panel.

> 为公司建立一个研究团队，安排一位研究主管和一位向他汇报的分析师。请主管定义市场研究简报的验收标准，再委派分析师写出调研框架。

In DeepSeek mode, the current company's relevant roles, instructions and recent results are sent to the [DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion/). The browser uses the local service, and the API key is read on the server. The demo uses scripted responses and a separate SQLite file.

## What works in v0.1

| Capability | Implementation |
| --- | --- |
| Company portfolio | A single Chief interface switches among independent company workspaces. |
| Autonomous hiring | The Chief produces a structured plan. The server checks the plan and commits hires, reporting lines and tasks together. |
| Reporting hierarchy | Each company has one root lead. Hires can report to current employees or other hires in the same plan. Managers can delegate only to direct reports. |
| Live organisation chart | Server-sent events update the chart for queued, running and failed work. Active employees and their reporting paths animate. |
| Job history | Results are saved in SQLite. The Chief can review recent company results, and employees receive recent results from their own work and tasks they delegated. |
| Local execution | The demo runs offline. The DeepSeek mode executes text assignments with the official API. The service listens on loopback and uses one local workspace owner. |

The chart shows the state of the actual job queue. A manager who has finished its stage is idle while its direct report carries out the next stage. Interrupted work is marked failed after a restart, and queued work resumes.

## Verification

```sh
npm test
```

Tests exercise multi-level hiring, company boundaries, direct-report delegation, transactional rollback, restart recovery, SSE and the model request format. The model integration test uses a stub response.

## Upstream work

The first milestone establishes the company hierarchy and event model. The next milestones cover native DeepSeek Harness execution, direct and group chat, memory review and transport integrations. The [upstream feature map](docs/upstream.md) records what is implemented and what remains for each project.

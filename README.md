# BotOrgHQ

在 DeepSeek Harness 中管理多家公司、部门和长期运行的 Bot 员工。集团 Chief 可以建立公司、招聘员工并委派任务。组织图实时显示员工状态，点击部门查看汇报层级，点击员工打开原生对话。

BotOrgHQ 提供内置 DSH 的独立桌面应用和可安装到现有 DSH 的插件。当前版本为 **0.4.0**，内置 **DSH 0.2.2-rc.2**，复用 **DS Bot 0.3.1** 的会话、交接、群聊和记忆能力。

## Desktop downloads

[当前桌面版与插件下载](https://github.com/xtshanlei/BotOrgHQ/releases/tag/v0.4.0-desktop) · [所有 Releases](https://github.com/xtshanlei/BotOrgHQ/releases)

| 系统 | 下载 |
| --- | --- |
| macOS · Apple 芯片 | [BotOrgHQ-0.4.0-mac-arm64.zip](https://github.com/xtshanlei/BotOrgHQ/releases/download/v0.4.0-desktop/BotOrgHQ-0.4.0-mac-arm64.zip) |
| macOS · Intel 芯片 | [BotOrgHQ-0.4.0-mac-x64.zip](https://github.com/xtshanlei/BotOrgHQ/releases/download/v0.4.0-desktop/BotOrgHQ-0.4.0-mac-x64.zip) |
| Windows · x64 | [BotOrgHQ-0.4.0-win-x64.exe](https://github.com/xtshanlei/BotOrgHQ/releases/download/v0.4.0-desktop/BotOrgHQ-0.4.0-win-x64.exe) |
| 现有 DSH 的插件 | [bot-org-hq-0.4.0.tgz](https://github.com/xtshanlei/BotOrgHQ/releases/download/v0.4.0-desktop/bot-org-hq-0.4.0.tgz) |

[SHA-256 校验文件](https://github.com/xtshanlei/BotOrgHQ/releases/download/v0.4.0-desktop/SHA256SUMS.txt)

Mac 解压后将 BotOrgHQ.app 放到“应用程序”，Windows 运行 EXE 安装器。Mac 应用使用 ad-hoc 签名，尚未经过 Apple 公证。Windows 安装器尚未签名。私有仓库的下载需要有访问权限的 GitHub 账号。

## 建立公司和部门

打开应用，在左侧选择 **BotOrgHQ**，进入 **公司工作台**。点击 **＋ 新建公司**，填写名称和职责。选择公司后，随时使用 **＋ 新建部门** 添加部门。

在应用内配置模型后，点击 **打开集团 Chief**，可以直接交给它建立组织和安排工作。

> 建立研究工作室，设立研究部和出版部。聘用研究主管和分析师，让分析师向研究主管汇报。请主管把证据整理任务放到公司任务看板，明确交付结果和验收标准，交给分析师执行。

Chief 使用 `org_hire` 创建原生 Bot，并记录所属部门和直属上级。员工的对话、记忆和工作文件由 DSH 与 DS Bot 保存。

## 公司任务看板

选择公司，点击 **任务看板**。人工可以新建、编辑和分配任务，Bot 使用同一套持久化记录。公司内员工可读取全公司的看板，了解彼此的工作。

| 状态 | 使用方式 |
| --- | --- |
| To-do | 已记录、等待开始 |
| In progress | 负责人开始工作时更新 |
| Waiting | 填写阻塞或等待原因 |
| Finished | 填写实际结果和证据后完成 |
| Aborted | 填写终止原因 |

每张任务卡包含负责人、工作说明、预期结果、验收标准、实际结果、证据与原因。证据字段可填写链接、文件路径、对话或验证记录，并说明它们支持什么结论。记录证据由负责人负责，系统检查必填字段，人工仍需审阅证据的真实性。

任务保留修改者、时间和修改内容。并发编辑使用 revision 检查，过期编辑会提示重新读取。`org_delegate` 自动建立任务卡，将任务 ID、预期结果和验收标准交给员工，通过 DS Bot 原生交接发送。人工创建任务卡后，可在 Chief 对话中要求它读取公司看板并安排执行。任务状态由人工或 Bot 明确更新，Bot 工作指示灯继续显示实际运行状态。

| Bot 工具 | 用途 |
| --- | --- |
| `org_list` | 公司、部门、员工和汇报关系 |
| `org_task_list` | 公司任务、结果、证据及历史 |
| `org_task_create` | 建立任务卡 |
| `org_task_update` | 更新状态、负责人、结果及证据 |
| `org_delegate` | 建立任务卡并发送给直属下属，Chief 可在公司内分配 |

员工可修改自己或直属下属的任务。Chief 和人工可以管理公司内的所有任务。员工不能读取其他公司的看板。

## 调整部门和直属关系

在公司工作台点击 **修改部门 / 直属关系**，选择员工、所属部门和直属上级。上级可以来自同一公司的其他部门，选择 **集团 Chief** 可将员工设为公司内的顶层员工。系统拒绝自我汇报、循环汇报和跨公司上级。

跨部门上级会显示在部门员工图的顶部，并可点击打开其对话。调整组织保留现有 Bot 身份、会话和记忆。

Bot 使用 `org_create_department` 在自己的公司添加部门。Chief 或员工当前直属上级可以使用 `org_change_reporting` 调整部门和上级。Chief 可管理所有公司。

## 应用内更新与数据保留

**从 0.2.0 升级时，请手动下载 0.4.0。** 从 0.3.0 起，可使用菜单 **帮助 → 检查更新…**，Mac 也可使用 **BotOrgHQ → 检查更新…**。

更新窗口会检查本仓库的 Releases，选择匹配系统与架构的新版本，在应用内下载并校验 SHA-256。安装会请求确认，随后停止 DSH、备份完整数据目录并启动安装。正在运行的任务会被中断，升级后可以检查看板和对话继续工作。

应用沿用原来的用户数据目录。配置、凭据、Bot 身份、公司、部门、任务、对话、附件和记忆继续保存在该目录下的 `dsh` 文件夹中。首次启动不同版本时，会在运行内核迁移前再建立一份快照。组织数据 v1 会保留原文件备份，并通过添加任务与历史字段迁移到 v2。

| 系统 | 默认数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/BotOrgHQ` |
| Windows | `%APPDATA%/BotOrgHQ` |
| Linux | `~/.config/BotOrgHQ` |

在 **帮助 → 打开数据目录** 查看实际位置，在更新窗口点击 **打开备份文件夹** 查看快照。备份存放于 `backups`，包含 `dsh` 和版本说明。恢复时先退出应用，保留当前目录副本，再使用所需快照中的 `dsh` 替换数据目录内的 `dsh`。备份包含凭据，应按原始数据同样保护。

仓库仍为私有时，更新窗口中的 **私有 GitHub 仓库访问** 可保存有本仓库 Contents 读取权限的 GitHub Token。Token 使用操作系统安全存储加密。仓库公开后可清除 Token。Mac 更新会保留旧应用包副本，方便需要时回退。

## 安装到现有 DSH

使用 **DSH 0.2.2-rc.2**。在 DSH Desktop 中打开 **Plugins → Add plugin**，输入下载的 `bot-org-hq-0.4.0.tgz` 的绝对路径，启用后从侧栏进入 BotOrgHQ。

DSH Web 使用独立的 DSH CLI 和 pnpm。

```sh
dsh plugin --profile web add /absolute/path/bot-org-hq-0.4.0.tgz
dsh web
```

同一个 profile 如果已启用原始 DS Bot 插件，先停用原入口。BotOrgHQ 自带 DS Bot 的宿主和界面，各插件使用各自的数据目录。旧 BotOrgHQ v0.1 SQLite 和独立 DS Bot 名册仍需要单独导入。公司权限覆盖本插件的组织工具和任务板，底层 DS Bot 的团队共享记忆与团队设置仍采用上游行为。

## 开发与发布

使用 Node.js 24.9 或更新版本，在目标操作系统和架构上构建。

```sh
npm ci
npm test
npm run build
npm --prefix desktop ci
npm --prefix desktop run dist
```

开发启动使用 `npm --prefix desktop run prepare-runtime`，然后 `npm --prefix desktop start`。原生内核与数据重启检查使用 `node scripts/smoke-desktop.mjs`。

GitHub Actions 在 `main` 的桌面版本号变动时构建 Windows x64、Mac arm64 和 Mac x64，也可从 Actions 手动运行。每个平台检查打包后的 DSH、Chief 会话、任务 API、备份和重启保留，通过后把三个安装包和插件直接上传到 Release 草稿，校验文件齐全后再公开发布。PR 单独执行构建和工作台检查。升级时同步根目录和 `desktop` 的版本号与 lockfile。

[上游集成和归属说明](docs/upstream.md)


## 主动自治（0.4.0）

公司工作台新增长期目标、主动活动、触发器、审批、自治设置和指标。
自治默认关闭。启用后，Chief 可以在本机宿主运行期间定期检查授权目标并组织
公司内部工作。主动模式使用已配置的 DSH 模型，并通过宿主限制能访问的数据
与工具。当前覆盖公司内的资料分析和草稿工作。

在桌面版使用 **帮助 → 导出或导入数据…**，可将完整本地 DSH 文件夹打包为
密码加密的归档，迁移到另一台机器时先验证再切换。

- [设置目标、授权、触发器和审批](docs/proactive-user-guide.md)
- [升级、加密导出与回滚](docs/proactive-migration.md)
- [执行边界、架构和兼容性](docs/proactive-architecture.md)
- [变更记录](CHANGELOG.md)

# Upstream integration

| Project | Role in BotOrgHQ |
| --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | DSH 0.2.2-rc.2 loads the Cordis host, native sidebar and main panel. DSH supplies the configured model, sessions and connection. |
| [DS Bot](https://github.com/Fei2411/DS-Bot/tree/6559c9e7c4ef71c292e6ac50f690031133536fe0) | BotOrgHQ pins npm `ds-bot@0.3.1`. The host extends its `createRuntime` with organisation tools and delegates through its native `message_bot`. The build wraps the published DS Bot client factory alongside the organisation panel. |
| [Tobs / DeepSeekBot](https://github.com/BotHarness/DeepSeekBot) | Tobs-specific Git memory, Bot marketplace and identity integrations are pending. |

The DS Bot client shipped in the packed plugin retains its [Apache-2.0 licence](../third-party/DS-Bot-LICENSE) and [NOTICE](../third-party/DS-Bot-NOTICE). The original BotOrgHQ files implement the company and department model, tool scope and organisation panel. The source pins the DS Bot version because its runtime and client factory are version-specific.

BotOrgHQ provides a DSH plugin and a desktop package that runs the same plugin in its own DSH profile. The organisation panel reads the active turns of native Bots, including work in their DS Bot chats. The user can switch between the company overview and a department's direct-report tree, and open any employee's conversation from its card.

The desktop packaging follows the application-owned profile and separate host process used by [DS Bot Desktop](https://github.com/Fei2411/DS-Bot/tree/71d344b/app). BotOrgHQ uses a plain bundled Node process for the host on all three targets, with its own app data and an authenticated loopback connection. The desktop package retains the plugin’s upstream license and notice.


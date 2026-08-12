# AutoTalon

[English](README.md) | [简体中文](README.zh-CN.md)

[CI](https://github.com/XD319/auto-talon/actions/workflows/ci.yml)
[npm](https://www.npmjs.com/package/auto-talon)
[Node.js](https://nodejs.org/)
[License: MIT](LICENSE)

**AutoTalon 是一个本地优先、可长期运行的个人智能体：它记得你做过的事、能按计划自动运行，在沙箱与审批约束下调用真实工具、跨任务记忆、无人值守按计划运行，还能从飞书/Lark 或本地 webhook 接入并留下可随时检查的执行痕迹。**举个例子：在 `talon tui` 里发起一个任务，让它每天早上帮你过一遍收件箱，再用 `talon trace` 查看它到底做了什么。TUI 是日常交互界面；CLI 负责自动化和诊断；各类 gateway 把外部聊天接入同一个受治理的runtime。

## 目录

- [为什么选择 AutoTalon](#为什么选择-autotalon)
- [安装](#安装)
- [常用命令](#常用命令)
- [TUI 斜杠命令](#tui-斜杠命令)
- [能力概览](#能力概览)
- [安全模型](#安全模型)
- [范围与限制](#范围与限制)
- [文档](#文档)
- [参与贡献](#参与贡献)
- [License](#license)



## 为什么选择 AutoTalon

- **长期运行的操作者 agent**：`talon tui` 把对话、会话（session）、收件箱（inbox）、待办（todo）、记忆复查、审批和运行时状态放进同一个终端界面，服务同一个 agent。
- **默认受治理的工具调用**：shell、process、network、file 工具都在沙箱策略（sandbox policy）和审批规则约束下运行，每次调用都会记录为 trace 事件、审计日志（audit log）和回滚产物（rollback artifact）。
- **可积累的记忆**：分层记忆同时提供 profile、project、working 记忆以及 experience、skill 引用，跨任务可用，并保留每次召回（recall）的来源。
- **Provider 自由度**：通过统一的 provider catalog 配置 OpenAI-compatible、Anthropic-compatible、Ollama、OpenRouter、GLM、Moonshot、Qwen、xAI、Gemini、MiniMax、讯飞、mock 或自定义兼容 endpoint。
- **多个入口，共用同一运行时**：TUI、CLI、飞书/Lark、本地 webhook 和 MCP surfaces 共享同一套会话、记忆和治理规则。
- **维护者级诊断能力**：源码仓库内置 replay、确定性 smoke fixture、盲测真实模型 eval、baseline、release check 和 npm pack dry-run。



## 安装

要求：

- Node.js `>=22.13.0`
- 真实助理运行需要 provider（模型服务）API key（想先试用可跳过，改用 mock provider）
- **仅开发者：** Corepack（随 Node.js 附带），用于锁定仓库的 pnpm 版本

先选一条路径：

| 路径 | 适用对象 | 命令前缀 |
| --- | --- | --- |
| [普通用户（npm）](#普通用户npm) | 日常安装与使用 AutoTalon | `talon ...` |
| [开发者（源码）](#开发者源码) | 贡献代码或本地跑仓库检出 | `corepack pnpm dev ...` |

两条路径的 provider 配置参数相同，只是 CLI 入口不同。

### 普通用户（npm）

#### 两分钟试用（无需凭据）

先确认 Node（`node -v` 需为 `>=22.13.0`；不支持 Node 20）。此路径不需要 API key。

```bash
npm install -g auto-talon
talon init --yes
talon provider setup mock
talon provider test
talon run "say hello"
talon tui
```

`provider test` 与 `talon run` 应在无凭据时成功。随后打开 `talon tui` 发一条短消息——
mock 回复是确定性演示，不是真实模型。

若在进入 TUI 前失败：

| 现象 | 处理 |
| --- | --- |
| `node:sqlite` / 不支持的 Node | 升级到 Node.js `>=22.13.0` |
| 全局安装后提示 `talon: command not found` | 确认 npm 全局 bin 已在 `PATH`，然后重新打开终端 |
| Provider / 缺少 key 报错 | 重新执行 `talon provider setup mock`（先不要配真实 provider） |
| 之后代码搜索变慢或异常 | 可选安装 `rg`（见 [Windows 排查](docs/user/windows-troubleshooting.md)）；mock 首次试用不必安装 |

更多说明见 [Quickstart](docs/user/quickstart.md#no-credentials-mock-walkthrough)。

#### 使用真实 provider

`talon provider setup` 与 `talon provider custom add` **默认写入用户级（全局）配置**
（`~/.auto-talon/provider.config.json`），在任意工作区都可用。只有加 `--workspace`
时才会写入当前项目的 `.auto-talon/provider.config.json`。可用
`talon provider status` 查看当前生效的是哪一层。

**内置 provider**（以 OpenAI 为例）：

```bash
npm install -g auto-talon
talon init --yes
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider test
talon tui
```

其他内置 provider 流程相同，例如
`talon provider setup anthropic|gemini|openrouter|ollama|glm|moonshot|minimax|qwen|xai|xfyun-coding ...`。

**OpenAI 兼容 endpoint**（DeepSeek、本地网关、厂商代理等）需显式传入
`--base-url` 与 `--model`：

```bash
talon provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key "$DEEPSEEK_API_KEY"
talon provider test
```

也可以注册命名自定义 provider（方便在 TUI 里用 `/model deepseek:deepseek-chat`）：

```bash
talon provider custom add deepseek --transport openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key "$DEEPSEEK_API_KEY" --display-name DeepSeek
talon provider use deepseek
talon provider test
```

PowerShell：请把整条命令写在一行（不要用 bash 的 `\` 换行），或用反引号 `` ` ``
换行。为当前会话设置 key：

```powershell
$env:DEEPSEEK_API_KEY = "your-api-key"
talon provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key $env:DEEPSEEK_API_KEY
```

安装后的更多用法见 [Quickstart](docs/user/quickstart.md)、[Install](docs/user/install.md)。

### 开发者（源码）

在本仓库上开发或调试时走这条路径。把普通用户路径里的每个 `talon` 命令换成
`corepack pnpm dev` 即可。

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev provider setup mock
corepack pnpm dev provider test
corepack pnpm dev tui
```

真实 provider 示例（参数与普通用户相同）：

```bash
corepack pnpm dev provider setup openai --api-key "$OPENAI_API_KEY"
# 或 DeepSeek / 其他兼容 endpoint：
corepack pnpm dev provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key "$DEEPSEEK_API_KEY"
corepack pnpm dev provider test
corepack pnpm dev tui
```

一键引导脚本（安装 + 构建 + init）：

- Linux/macOS：`bash scripts/setup.sh`
- Windows PowerShell：`./scripts/setup.ps1`

质量检查、发布验证与维护者诊断见
[CONTRIBUTING.md](CONTRIBUTING.md#develop-from-source)。

### Windows

原生 Windows 已支持：CLI、TUI 和 gateway 都无需 WSL 即可运行。
ripgrep、Git 与 PowerShell 执行策略相关的排查见
[Windows 排查](docs/user/windows-troubleshooting.md)。
在 Windows 上从源码开发可用上面的 `./scripts/setup.ps1`。

### 升级

从仍使用旧 thread→session schema 的预览检出升级时，需要一次性迁移。若命令失败并提示
`Legacy workspace migration required`，在工作区根目录执行：

```bash
talon doctor --fix
talon doctor
```

源码检出则用 `corepack pnpm dev doctor --fix`。doctor 输出会列出当前遗留表/转写文件、
影响范围，以及确切修复命令。迁移完成前，`talon tui` / `talon run` 会保持阻塞。

## 常用命令

```bash
talon tui                              # 日常交互式 agent 界面
talon run "review the changed files"   # 可脚本化的一次性执行
talon continue --last                  # 恢复上一个任务
talon trace <task_id> --summary        # 检查 agent 做了什么
talon provider use ollama              # 切换当前 provider
talon schedule create "Review my inbox" --name "Daily review" --every 1d
talon gateway serve-webhook --port 7070
```

完整的 CLI/TUI 命令（包括会话、审计、记忆、收件箱、承诺项、技能和 gateway 适配器）见[命令参考](docs/user/commands.md)。

## TUI 斜杠命令

在 `talon tui` 里，斜杠命令用于管理会话、模型、记忆和调度：


| 命令                                  | 作用            |
| ----------------------------------- | ------------- |
| `/new [title]`、`/clear [name]`      | 新建一个命名会话      |
| `/sessions`、`/resume`               | 选择或恢复会话       |
| `/model [provider:model]`           | 查看或切换当前模型     |
| `/memory`、`/memory review`          | 查看记忆和复查队列     |
| `/schedule create`、`/schedule list` | 在聊天里创建和管理定时任务 |
| `/next list`、`/commitments list`    | 跟踪待办和承诺项      |


完整斜杠命令列表见[命令参考](docs/user/commands.md)。

## 能力概览


| 领域       | 你能得到什么                                                     |
| -------- | ---------------------------------------------------------- |
| Agent 体验 | TUI 聊天，含会话、transcript、审批、记忆、待办和状态面板                        |
| CLI 执行   | `run`/`continue`、任务与会话检查、trace/audit、工作区地图、回滚、doctor       |
| 治理       | 沙箱作用域、审批提示、持久 allow 规则、审计日志和回滚快照                           |
| 记忆       | Profile/project/working 记忆，附带 experience 与 skill 引用，以及召回解释 |
| 调度       | 一次性、interval、cron 和自然语言定时，支持 inbox/webhook 投递              |
| Provider | 一个统一目录完成配置、切换、健康检查和诊断，覆盖多家 provider                        |
| Gateway  | 飞书/Lark 与本地 webhook 适配器，共享同一运行时和会话                         |
| MCP 与技能  | MCP client/server 接口，以及带草稿和 promotion 的技能注册表               |
| 诊断       | Smoke 套件、盲测能力 eval、replay、baseline 和发布检查清单                 |


> 长期记忆默认关闭。在 TUI 中用 `/memory on` 或运行 `talon memory on` 开启；详见 [docs/user/memory.md](docs/user/memory.md)。



## 安全模型

AutoTalon 面向需要真实工具权限、同时也需要可见护栏的本地操作者。

- 本地状态存放在 `.auto-talon/`，包括 SQLite 数据、日志、artifact、config、审批规则和回滚快照。
- 高风险工具可以在执行前要求显式审批。审批决策会生成 fingerprint，并可通过持久规则限定作用范围。
- Shell 和文件系统访问会在执行前经过沙箱策略和项目边界检查。
- Tool call、provider event、审批、policy 决策、file write 和回滚产物都会被记录，便于事后检查。
- 飞书/Lark 与 webhook 输入通过 gateway adapter 进入，因此共享同一套运行时策略，而不是绕过本地治理层。

在暴露 gateway 或处理敏感项目目录前，请阅读 [SECURITY.md](SECURITY.md)。

## 范围与限制

- AutoTalon 要求 Node.js `>=22.13.0`，因为运行时存储依赖内置 `node:sqlite` 模块；不支持 Node.js 20。
- AutoTalon 是本地优先、面向单个操作者的 agent，不是托管 SaaS、团队控制平面或多租户 agent 服务。
- 真实 provider 运行需要用户自行提供凭据。Mock 和 scripted smoke provider 只用于测试和诊断。
- v0.1.0 包含飞书/Lark 与本地 webhook gateway adapter；Slack、Telegram、Discord、语音、浏览器自动化、图像生成、移动 companion app 仍不在本次发布范围内。**桌面 companion**（Tauri + 本地 `session-api`）已列入 `v0.2.0` 规划，**尚未发布** —— 见 [ROADMAP.zh-CN.md](ROADMAP.zh-CN.md) 与 [docs/dev/desktop-companion.md](docs/dev/desktop-companion.md)。



## 文档


| 目标               | 入口                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| 安装和首次运行          | [安装](docs/user/install.md)、[快速开始](docs/user/quickstart.md)                                     |
| 学习 CLI/TUI 命令    | [命令](docs/user/commands.md)                                                                    |
| 配置 provider 和运行时 | [配置参考](docs/user/config-reference.md)、[Provider 排查](docs/troubleshooting/provider.md)、[Provider 路由与预算](docs/provider-routing-budget.md)、[Prompt cache 计量](docs/dev/prompt-cache.md) |
| 理解审批和沙箱          | [审批](docs/user/approvals.md)、[Sandbox 排查](docs/troubleshooting/sandbox.md)                     |
| 接入外部入口           | [Gateway](docs/user/gateway.md)、[Gateway 排查](docs/troubleshooting/gateway.md)                  |
| 使用记忆和 skills     | [Skills](docs/user/skills.md)、[Memory 排查](docs/troubleshooting/memory.md)                      |
| 集成 MCP           | [MCP](docs/user/mcp.md)                                                                        |
| 验证发布             | [Replay 与 eval](docs/user/replay-and-eval.md)、[兼容矩阵](docs/compatibility-matrix.md)             |
| 开发 AutoTalon     | [架构](docs/dev/architecture.md)、[模块边界](docs/dev/module-boundaries.md)、[测试](docs/dev/testing.md)、[上下文窗口](docs/dev/context-window.md)、[桌面 companion](docs/dev/desktop-companion.md) |


发布历史见 [Changelog](CHANGELOG.md)。

## 参与贡献

欢迎贡献。先按上面的[开发者（源码）安装路径](#开发者源码)跑起来，再看
[CONTRIBUTING.md](CONTRIBUTING.md) 了解质量检查与发布验证。下一版本计划与可认领工作见
[ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)。问题反馈请前往
[issue tracker](https://github.com/XD319/auto-talon/issues)。

## License

MIT. See [LICENSE](LICENSE).
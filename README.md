# AutoTalon

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/XD319/auto-talon/actions/workflows/ci.yml/badge.svg)](https://github.com/XD319/auto-talon/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/auto-talon?logo=npm)](https://www.npmjs.com/package/auto-talon)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**AutoTalon is a local-first, long-running personal agent: it can automatically
run your programming, office, and everyday tasks on a schedule, call real tools
under sandbox and approval control, accumulate memory and experience across
tasks, and connect through gateways such as Feishu while leaving execution
traces you can inspect anytime.**

<!-- TODO: add a `talon tui` demo GIF/screenshot here, e.g. ![AutoTalon TUI demo](docs/assets/tui-demo.gif) -->

## Table of contents

- [Why AutoTalon](#why-autotalon)
- [Install](#install)
- [Common commands](#common-commands)
- [TUI slash commands](#tui-slash-commands)
- [Capabilities](#capabilities)
- [Security model](#security-model)
- [Scope and limits](#scope-and-limits)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Why AutoTalon

- **A long-lived operator agent**: `talon tui` brings conversation, sessions,
  inbox, todos, memory review, approvals, and runtime status into a single
  terminal for one agent.
- **Governed tool use by default**: shell, process, network, and file tools run
  under sandbox policy and approval rules, and every call is captured as trace
  events, audit logs, and rollback artifacts.
- **Memory that compounds**: layered memory keeps profile, project, and working
  memory, plus experience and skill references, available across tasks without
  hiding where a recall came from.
- **Provider freedom**: configure OpenAI-compatible, Anthropic-compatible,
  Ollama, OpenRouter, GLM, Moonshot, Qwen, xAI, Gemini, MiniMax, iFLYTEK, mock,
  or custom compatible endpoints through one provider catalog.
- **Multiple entry points, one runtime**: TUI, CLI, Feishu/Lark, local webhooks,
  and MCP surfaces share the same sessions, memory, and governance.
- **Maintainer-grade diagnostics**: replay, deterministic smoke fixtures, blind
  real-model evals, baselines, release checks, and package dry-runs ship with
  the source checkout.

## Install

Requirements:

- Node.js `>=22.13.0`
- A provider API key for real assistant runs (skip it to try the mock provider first)
- **Developers only:** Corepack (bundled with Node.js) for the pinned pnpm version

Pick one path:

| Path | Who it's for | Command prefix |
| --- | --- | --- |
| [Users (npm)](#for-users-npm) | Install and run AutoTalon day to day | `talon ...` |
| [Developers (from source)](#for-developers-from-source) | Contribute or run a local checkout | `corepack pnpm dev ...` |

Provider setup flags are the same on both paths; only the CLI entrypoint differs.

### For users (npm)

#### Try it in two minutes (no credentials)

Confirm Node first (`node -v` must be `>=22.13.0`; Node 20 is not supported).
No API key is required for this path.

```bash
npm install -g auto-talon
talon init --yes
talon provider setup mock
talon provider test
talon run "say hello"
talon tui
```

`provider test` and `talon run` should succeed without credentials. Then open
`talon tui` and send a short message — mock replies are deterministic demos, not
a real model.

If something fails before the TUI:

| Symptom | What to do |
| --- | --- |
| `node:sqlite` / unsupported Node | Upgrade to Node.js `>=22.13.0` |
| `talon: command not found` after global install | Ensure npm's global bin directory is on `PATH`, then reopen the shell |
| Provider / missing-key errors | Re-run `talon provider setup mock` (do not set a real provider yet) |
| Slow or odd code search later | Optional: install `rg` ([Windows tips](docs/user/windows-troubleshooting.md)); mock first-run does not require it |

More detail: [Quickstart](docs/user/quickstart.md#no-credentials-mock-walkthrough).

#### Use a real provider

`talon provider setup` and `talon provider custom add` write **user-level
(global) config** by default (`~/.auto-talon/provider.config.json`), so the
provider is available in every workspace. Add `--workspace` only when you want
a project-local override (`.auto-talon/provider.config.json`). Check the active
layer with `talon provider status`.

**Built-in providers** (OpenAI example):

```bash
npm install -g auto-talon
talon init --yes
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider test
talon tui
```

Other built-ins use the same flow, for example
`talon provider setup anthropic|gemini|openrouter|ollama|glm|moonshot|minimax|qwen|xai|xfyun-coding ...`.

**OpenAI-compatible endpoints** (DeepSeek, local gateways, vendor proxies, and
similar). Pass `--base-url` and `--model` explicitly:

```bash
talon provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key "$DEEPSEEK_API_KEY"
talon provider test
```

Or register a named custom provider (handy for `/model deepseek:deepseek-chat`):

```bash
talon provider custom add deepseek --transport openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key "$DEEPSEEK_API_KEY" --display-name DeepSeek
talon provider use deepseek
talon provider test
```

PowerShell: put the whole command on one line (do not use bash `\` line
continuations), or break lines with a backtick `` ` ``. Set a session key with:

```powershell
$env:DEEPSEEK_API_KEY = "your-api-key"
talon provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key $env:DEEPSEEK_API_KEY
```

More usage after install: [Quickstart](docs/user/quickstart.md),
[Install](docs/user/install.md).

### For developers (from source)

Use this path to work on AutoTalon itself. Replace every `talon` command from
the user path with `corepack pnpm dev`.

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev provider setup mock
corepack pnpm dev provider test
corepack pnpm dev tui
```

Real provider example (same flags as users):

```bash
corepack pnpm dev provider setup openai --api-key "$OPENAI_API_KEY"
# or DeepSeek / other compatible endpoints:
corepack pnpm dev provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key "$DEEPSEEK_API_KEY"
corepack pnpm dev provider test
corepack pnpm dev tui
```

Bootstrap scripts (install + build + init):

- Linux/macOS: `bash scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1`

Quality checks, release validation, and maintainer diagnostics:
[CONTRIBUTING.md](CONTRIBUTING.md#develop-from-source).

### Windows

Native Windows is supported: the CLI, TUI, and gateways run without WSL.
See [Windows troubleshooting](docs/user/windows-troubleshooting.md) for ripgrep,
Git, and PowerShell execution-policy tips. Developers on Windows can use
`./scripts/setup.ps1` for the source checkout path above.

### Upgrading

Upgrading from a preview checkout that still uses the legacy thread→session
schema requires running `talon doctor --fix` once (or
`corepack pnpm dev doctor --fix` from a source checkout).

## Common commands

```bash
talon tui                              # daily interactive agent surface
talon run "review the changed files"   # scriptable one-shot execution
talon continue --last                  # resume the previous task
talon trace <task_id> --summary        # inspect what the agent did
talon provider use ollama              # switch the active provider
talon schedule create "Review my inbox" --name "Daily review" --every 1d
talon gateway serve-webhook --port 7070
```

See the [Commands reference](docs/user/commands.md) for the full CLI/TUI
surface, including sessions, audit, memory, inbox, commitments, skills, and
gateway adapters.

## TUI slash commands

Inside `talon tui`, slash commands drive sessions, models, memory, and scheduling:

| Command | What it does |
| --- | --- |
| `/new [title]`, `/clear [name]` | Start a fresh named session |
| `/sessions`, `/resume` | Pick or resume a session |
| `/model [provider:model]` | Show or switch the active model |
| `/memory`, `/memory review` | Inspect memory and the review queue |
| `/schedule create`, `/schedule list` | Schedule and manage work from chat |
| `/next list`, `/commitments list` | Track todos and commitments |

See the [Commands reference](docs/user/commands.md) for the full slash-command list.

## Capabilities

| Area | What you get |
| --- | --- |
| Agent experience | TUI chat with sessions, transcripts, approvals, memory, todos, and status panels |
| CLI execution | `run`/`continue`, task and session inspection, trace/audit, workspace map, rollback, doctor |
| Governance | Sandbox scopes, approval prompts, persisted allow rules, audit log, and rollback snapshots |
| Memory | Profile/project/working memory with experience and skill refs, plus recall explanations |
| Scheduling | One-shot, interval, cron, and natural-language timing with inbox/webhook delivery |
| Providers | One catalog to set up, switch, health-check, and diagnose many providers |
| Gateways | Feishu/Lark and local webhook adapters sharing the same runtime and sessions |
| MCP and skills | MCP client/server surfaces plus a skill registry with drafts and promotion |
| Diagnostics | Smoke suite, blind capability eval, replay, baselines, and a release checklist |

> Long-term memory is off by default. Turn it on with `/memory on` in the TUI or
> `talon memory on`; see [docs/user/memory.md](docs/user/memory.md).

## Security model

AutoTalon is designed for a local operator who wants an agent with real tool
access and visible guardrails.

- Local state is stored under `.auto-talon/`, including SQLite data, logs,
  artifacts, config, approval rules, and rollback snapshots.
- High-risk tools can require explicit approval before execution. Approval
  decisions are fingerprinted and can be scoped through persisted rules.
- Shell and filesystem access are checked against sandbox policy and project
  boundaries before execution.
- Tool calls, provider events, approvals, policy decisions, file writes, and
  rollback artifacts are recorded for later inspection.
- Feishu/Lark and webhook inputs enter through gateway adapters, so they share
  the same runtime policy instead of bypassing the local governance layer.

Read [SECURITY.md](SECURITY.md) before exposing gateways or running AutoTalon
against sensitive project directories.

## Scope and limits

- AutoTalon requires Node.js `>=22.13.0` because runtime storage uses the
  built-in `node:sqlite` module. Node.js 20 is not supported.
- AutoTalon is local-first and single-operator oriented. It is not a hosted
  SaaS, team control plane, or multi-tenant agent service.
- Real provider runs require user-supplied credentials. Mock and scripted smoke
  providers are for tests and diagnostics.
- v0.1.0 includes Feishu/Lark and local webhook gateway adapters. Slack,
  Telegram, Discord, voice, browser automation, image generation, and mobile
  companion apps remain outside this release. A **desktop companion** (Tauri +
  local `session-api`) is planned for `v0.2.0` and is **not shipped yet** — see
  [ROADMAP.md](ROADMAP.md) and
  [docs/dev/desktop-companion.md](docs/dev/desktop-companion.md).

## Documentation

| Goal | Start here |
| --- | --- |
| Install and first run | [Install](docs/user/install.md), [Quickstart](docs/user/quickstart.md) |
| Learn CLI/TUI commands | [Commands](docs/user/commands.md) |
| Configure providers and runtime | [Config reference](docs/user/config-reference.md), [Provider troubleshooting](docs/troubleshooting/provider.md), [Provider routing and budget](docs/provider-routing-budget.md), [Prompt cache accounting](docs/dev/prompt-cache.md) |
| Understand approvals and sandboxing | [Approvals](docs/user/approvals.md), [Sandbox troubleshooting](docs/troubleshooting/sandbox.md) |
| Connect external entry points | [Gateway](docs/user/gateway.md), [Gateway troubleshooting](docs/troubleshooting/gateway.md) |
| Use memory and skills | [Skills](docs/user/skills.md), [Memory troubleshooting](docs/troubleshooting/memory.md) |
| Integrate MCP | [MCP](docs/user/mcp.md) |
| Validate a release | [Replay and eval](docs/user/replay-and-eval.md), [Compatibility matrix](docs/compatibility-matrix.md) |
| Develop AutoTalon | [Architecture](docs/dev/architecture.md), [Module boundaries](docs/dev/module-boundaries.md), [Testing](docs/dev/testing.md), [Context window](docs/dev/context-window.md), [Desktop companion](docs/dev/desktop-companion.md) |

See the [Changelog](CHANGELOG.md) for release history.

## Contributing

Contributions are welcome. Start with the
[developer Install path](#for-developers-from-source), then see
[CONTRIBUTING.md](CONTRIBUTING.md) for quality checks and release validation.
The next-release plan and claimable work items are in [ROADMAP.md](ROADMAP.md).
Report issues at the [issue tracker](https://github.com/XD319/auto-talon/issues).

## License

MIT. See [LICENSE](LICENSE).

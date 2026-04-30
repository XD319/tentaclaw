# AutoTalon v0.1.0

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/XD319/auto-talon/actions/workflows/ci.yml/badge.svg)](https://github.com/XD319/auto-talon/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.0-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Personal assistant workspace for day-to-day execution.

AutoTalon is for personal knowledge workers who want a long-lived assistant
without giving up inspectability, local control, or cost awareness. `talon tui`
is the default home for daily work: today, inbox, threads, memory review, and
governed task execution all live in one workspace. The CLI remains the
automation, diagnostics, and maintenance surface, while Feishu/Lark and webhook
gateways provide formal external chat entry points into the same runtime.

## Primary Entry Points

- `talon tui`
  Daily workspace for conversation, inbox triage, thread follow-up, and memory-aware execution.
- `talon gateway serve-feishu`
  External IM entry for Feishu/Lark when you want the assistant to live inside a chat workflow.
- `talon run` / `talon continue`
  Scriptable execution and follow-up from the terminal for automation, batch work, and precise inspection.

## What It Does

- Opens a personal assistant workspace in `talon tui` with today/inbox/thread
  oriented workflows.
- Supports formal chat ingress through Feishu/Lark and local webhook adapters.
- Records task state, trace events, tool calls, approvals, and audit logs in a
  local SQLite workspace.
- Gates risky tool use with policy and explicit approval flows.
- Surfaces memory review in both TUI and CLI, including used-memory feedback
  and inbox-driven suggestions.
- Provides layered memory (`profile`/`project`/`working` +
  `experience_ref`/`skill_ref`) for repeatable work.
- Keeps runtime observation available through `talon ops` and CLI inspection
  commands.
- Supports replay, smoke tests, eval reports, and maintainer release checks.

## Demo

```text
$ talon init --yes
Initialized .auto-talon workspace files.

$ talon tui
# Open the daily workspace.
# Start or continue a thread, process inbox items, and review memory suggestions.

$ talon task list
$ talon trace <task_id> --summary
$ talon audit <task_id> --summary
# Drop to CLI when you want precise inspection or automation.
```

## Quick Start

Requirements:

- Node.js `>=22.13.0`
- Corepack enabled for source installs

Installed package:

```bash
npm install -g auto-talon
talon init --yes
talon tui
```

Optional chat-platform entry:

```bash
pnpm add @larksuiteoapi/node-sdk
talon gateway serve-feishu --cwd .
```

Source checkout:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev tui
```

## Typical Flows

Daily work in TUI:

```bash
talon tui
talon ops
```

Bring the assistant into chat:

```bash
talon gateway serve-feishu --cwd .
talon gateway list-adapters
```

Automate or inspect from CLI:

```bash
talon run "review the changed files"
talon continue --last
talon task list
talon trace <task_id> --summary
talon audit <task_id> --summary
```

Local API or SDK integration:

```bash
talon gateway serve-webhook --port 7070
```

Validate providers and release readiness:

```bash
talon provider list
talon provider test
talon eval smoke
talon release check
```

## When To Use It

- You want a TUI-centered personal assistant workspace with auditable execution
  history.
- You want today/inbox/thread actions to stay close to your terminal workflow
  without reducing the product to one-off prompt execution.
- You want an assistant that can move between TUI, CLI, and chat-platform
  entry points while sharing the same governed runtime, memory, approvals, and
  audit trail.
- You need policy and approval behavior before allowing file or shell actions.
- You want durable memory, skill recall, replay, and eval tooling around
  ongoing knowledge work instead of one-off prompts.

## Positioning

AutoTalon is a local-first personal assistant product for individual operators
and knowledge workers, backed by an inspectable runtime rather than a hosted
black box. The user-facing promise is a low-cost long-term assistant with a
primary TUI workspace, supported by CLI automation and diagnostics plus formal
external chat entry through adapters such as Feishu/Lark. The core package
stays intentionally small, and integrations are loaded only when their gateway
command is used. Runtime observation remains available via `talon ops`, while
`talon dashboard` is preserved as a compatibility alias.

## Documentation

User docs:

- `docs/user/install.md`
- `docs/user/quickstart.md`
- `docs/user/commands.md`
- `docs/user/replay-and-eval.md`
- `docs/user/approvals.md`
- `docs/user/skills.md`
- `docs/user/gateway.md`
- `docs/user/mcp.md`
- `docs/user/config-reference.md`

Developer docs:

- `docs/dev/architecture.md`
- `docs/dev/module-boundaries.md`
- `docs/dev/plugin-development.md`
- `docs/dev/testing.md`

Troubleshooting:

- `docs/troubleshooting/provider.md`
- `docs/troubleshooting/sandbox.md`
- `docs/troubleshooting/gateway.md`
- `docs/troubleshooting/memory.md`

## Release Validation

```bash
corepack pnpm check
corepack pnpm dev release check
```

`talon release check` is a maintainer release gate for this repository. Use
`talon doctor` for user workspace health checks.

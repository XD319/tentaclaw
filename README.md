# AutoTalon v0.1.0

Low-cost, long-running agent assistant for personal knowledge work.

AutoTalon is for personal knowledge workers who want an agent assistant they can
run for the long haul without giving up inspectability, local control, or cost
awareness. It keeps the product centered on a CLI-first workflow while the
runtime underneath provides governed execution, durable memory, traceability,
skills, gateway adapters, and evaluation surfaces.

## What It Does

- Runs agent tasks from the terminal with configurable provider profiles.
- Records task state, trace events, tool calls, approvals, and audit logs in a
  local SQLite workspace.
- Gates risky tool use with policy and explicit approval flows.
- Supports replay, smoke tests, eval reports, and maintainer release checks.
- Provides layered memory (`profile`/`project`/`working` + `experience_ref`/`skill_ref`) for repeatable work.
- Exposes optional gateway adapters for local webhooks and Feishu/Lark.
- Includes Ink-based TUI and dashboard views for operators who want an
  interactive shell-native surface.

## Demo

```text
$ talon init --yes
Initialized .auto-talon workspace files.

$ talon run "summarize this repository"
task_id=task_...
status=succeeded
output=This repository contains AutoTalon, a CLI-first agent assistant...

$ talon trace task_... --summary
provider.call -> tool.call -> tool.result -> task.completed

$ talon audit task_... --summary
policy decisions, approvals, sandbox decisions, and file writes are recorded.
```

## Quick Start

Requirements:

- Node.js `>=22.13.0`
- Corepack enabled for source installs

Installed package:

```bash
npm install -g auto-talon
talon init --yes
talon run "summarize this repository"
```

Source checkout:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev run "summarize this repository"
```

## Common Workflows

Run and inspect a task:

```bash
talon run "review the changed files"
talon task list
talon trace <task_id> --summary
talon audit <task_id> --summary
```

Use the interactive surfaces:

```bash
talon tui
talon dashboard
```

Validate providers and release readiness:

```bash
talon provider list
talon provider test
talon eval smoke
talon release check
```

Serve integrations:

```bash
talon gateway serve-webhook --port 7070
talon gateway serve-feishu --cwd .
talon gateway list-adapters
```

## When To Use It

- You want a local-first agent assistant with auditable execution history.
- You need policy and approval behavior before allowing file or shell actions.
- You want durable memory, skill recall, replay, and eval tooling around ongoing
  knowledge work instead of one-off prompts.
- You want chat, webhook, or MCP surfaces to route through the same governed
  runtime core.

## Positioning

AutoTalon is a product for personal knowledge workers, backed by an inspectable
agent runtime rather than a hosted black box. The user-facing promise is a
low-cost long-term assistant; the technical foundation is CLI operation,
governance, traceability, reproducible execution, memory, and adapter boundaries.
The core package stays intentionally small, and integrations such as Feishu/Lark
are loaded only when their gateway command is used.

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

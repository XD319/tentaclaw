# auto-talon v0.1.0

CLI-first agent runtime focused on governance, traceability, and reproducible execution.

## Quick Start

Installed package:

```bash
npm install -g auto-talon
agent init --yes
agent run "summarize this repository"
```

Source checkout:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev run "summarize this repository"
```

## Documentation

- User docs:
  - `docs/user/install.md`
  - `docs/user/quickstart.md`
  - `docs/user/commands.md`
  - `docs/user/replay-and-eval.md`
  - `docs/user/approvals.md`
  - `docs/user/skills.md`
  - `docs/user/gateway.md`
  - `docs/user/mcp.md`
  - `docs/user/config-reference.md`
- Developer docs:
  - `docs/dev/architecture.md`
  - `docs/dev/module-boundaries.md`
  - `docs/dev/plugin-development.md`
  - `docs/dev/testing.md`
- Troubleshooting:
  - `docs/troubleshooting/provider.md`
  - `docs/troubleshooting/sandbox.md`
  - `docs/troubleshooting/gateway.md`
  - `docs/troubleshooting/memory.md`

## Release Validation

```bash
corepack pnpm check
corepack pnpm dev release check
```

`agent release check` is a maintainer release gate for this repository. Use `agent doctor` for user workspace health checks.

# Install

## Requirements

- Node.js `>=22.13.0`
- A provider API key for real assistant runs (optional if you start with `mock`)
- **Developers only:** Corepack enabled (bundled with Node.js)

Node 22.13.0 is the minimum because auto-talon uses the built-in `node:sqlite`
runtime storage module without an experimental flag. CI currently verifies the
repository on Node 22.13.0.

Pick one path:

| Path | Who it's for | Command prefix |
| --- | --- | --- |
| [Users (npm)](#users-npm) | Install and run AutoTalon day to day | `talon ...` |
| [Developers (from source)](#developers-from-source) | Contribute or run a local checkout | `corepack pnpm dev ...` |

Provider setup flags are the same on both paths; only the CLI entrypoint differs.
See the [README Install](../../README.md#install) section for DeepSeek /
OpenAI-compatible examples and PowerShell notes.

## Users (npm)

```bash
npm install -g auto-talon
talon init --yes
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider test
talon tui
```

Try without credentials first:

```bash
talon provider setup mock
talon provider test
talon tui
```

## Developers (from source)

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev provider setup openai --api-key "$OPENAI_API_KEY"
corepack pnpm dev provider test
corepack pnpm dev tui
```

Or start with mock, then switch to a real provider using the same flags as the
user path (`corepack pnpm dev provider setup ...`).

Bootstrap scripts:

- Linux/macOS: `bash scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1` (checks Node, builds, bootstraps config, and warns if `rg` is missing — see [Windows troubleshooting](windows-troubleshooting.md))

Quality checks and release validation: [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Verify

After a global install:

```bash
talon version
talon doctor
```

From a source checkout:

```bash
corepack pnpm dev version
corepack pnpm dev doctor
```

For a daily first-run experience, open the TUI. Use `run` and other CLI commands
when you want automation, diagnostics, or scripted execution.
`provider setup` stores the default provider in user config so later workspaces
can open with the same provider selection.

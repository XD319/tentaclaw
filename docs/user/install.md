# Install

## Requirements

- Node.js `>=22.13.0`
- Corepack enabled

Node 22.13.0 is the minimum because auto-talon uses the built-in `node:sqlite`
runtime storage module without an experimental flag. CI currently verifies the
repository on Node 22.13.0.

## Quick Install

From npm:

```bash
npm install -g auto-talon
talon init --yes
talon tui
```

From source:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev tui
```

Or use scripts:

- Linux/macOS: `bash scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1`

## Verify

```bash
talon version
talon doctor
```

For a daily first-run experience, open `talon tui`. Use `talon run` and other
CLI commands when you want automation, diagnostics, or scripted execution.

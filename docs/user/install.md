# Install

## Requirements

- Node.js `>=22.5.0`
- Corepack enabled

## Quick Install

From npm:

```bash
npm install -g auto-talon
agent init --yes
```

From source:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
```

Or use scripts:

- Linux/macOS: `bash scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1`

## Verify

```bash
agent version
agent doctor
```

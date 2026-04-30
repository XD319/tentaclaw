# Gateway

## Local webhook

```bash
talon gateway serve-webhook --port 7070
```

## Feishu

The Feishu/Lark adapter is loaded as an optional gateway plugin so the core CLI
runtime stays lightweight. Install the Lark SDK only in workspaces that run this
adapter. This is a formal chat entry point into the same runtime used by
`talon tui`, not just an adapter demo:

```bash
pnpm add @larksuiteoapi/node-sdk
```

```bash
talon gateway serve-feishu --cwd .
```

Configuration files:

- `.auto-talon/gateway.config.json`
- `.auto-talon/feishu.config.json`

Inspect adapters:

```bash
talon gateway list-adapters
```

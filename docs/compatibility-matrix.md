# Compatibility Matrix (v0.1.0)

## Runtime

- Node.js `>=22.13.0`: supported and covered by CI runtime-minimum and full
  Node 22 verification.
- Node.js 20: covered by a CI compatibility-floor check. It is not a supported
  runtime because auto-talon uses the built-in `node:sqlite` storage module.
- Package module format: ESM (`"type": "module"`).

## Terminal UI

- Ink `^7.0.1`: supported for TUI and dashboard surfaces.
- React `^19.2.5` with `@types/react` `^19.2.14`: supported.
- React 17 / Ink 3 are no longer supported.

## Provider

- `mock` + `scripted-smoke`: supported and covered in CI smoke/eval.
- `glm` + `openai-compatible` transport: supported; validate with `talon provider test`.
- `xfyun-coding` + `openai-compatible` transport: supported; validate with `talon provider test`.
- `anthropic-compatible` custom providers: supported via `customProviders`.

## Gateway

- `local-webhook`: supported (`talon gateway serve-webhook`).
- `feishu`: supported (`talon gateway serve-feishu`).
- Other adapters (Slack/Telegram/Discord): not included in v0.1.0.

## Memory / Storage

- Runtime schema baseline: `PRAGMA user_version = 10`.
- Schema upgrades from legacy unversioned DB: supported via migration pipeline.
- Config files without `version`: auto-migrated to `version: 1`.
- Scope rename compatibility:
  - legacy `agent` scope is migrated to `profile`
  - legacy `session` scope is presented as `working` in read surfaces
  - CLI `memory show session|agent` remains as compatibility aliases

## Skills

- Sources: project + local skill roots supported.
- Attachments: `references`, `templates`, `scripts`, `assets`.
- Overrides: `.auto-talon/skill-overrides.json` supported.

## Validation Path

- `talon release check` from the auto-talon repository root
- `talon eval run`
- `talon smoke run`
- `talon eval beta`

# Compatibility Matrix (v0.1.0)

## Provider

- `mock` + `scripted-smoke`: supported and covered in CI smoke/eval.
- `glm` + `openai-compatible` transport: supported; validate with `agent provider test`.
- `xfyun-coding` + `openai-compatible` transport: supported; validate with `agent provider test`.
- `anthropic-compatible` custom providers: supported via `customProviders`.

## Gateway

- `local-webhook`: supported (`agent gateway serve-webhook`).
- `feishu`: supported (`agent gateway serve-feishu`).
- Other adapters (Slack/Telegram/Discord): not included in v0.1.0.

## Memory / Storage

- Runtime schema baseline: `PRAGMA user_version = 2`.
- Schema upgrades from legacy unversioned DB: supported via migration pipeline.
- Config files without `version`: auto-migrated to `version: 1`.

## Skills

- Sources: project + local skill roots supported.
- Attachments: `references`, `templates`, `scripts`, `assets`.
- Overrides: `.auto-talon/skill-overrides.json` supported.

## Validation Path

- `agent release check` from the auto-talon repository root
- `agent eval run`
- `agent eval smoke`
- `agent eval beta`

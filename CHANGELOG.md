# Changelog

## Unreleased

- Anthropic-compatible providers emit `cache_control: { type: "ephemeral" }`
  breakpoints on the stable prefix (last tool schema, system prompt, memory
  recall) and map `cache_read_input_tokens` into `cachedInputTokens`.
- Leading system messages are ordered stable → variable so prompt-cache
  prefixes stay reusable without moving later compaction/tail nudges.
- Added `talon eval compounding` to run the same suite with empty vs accumulated
  project skills, plus the `compounding-self-evolution.v1` task dataset.

## v0.1.1

- Added layered skills with configurable precedence across team, project, user
  (`local`), and builtin roots; team skills can be marked `required`, and
  promotion/rollback can target `project` | `user` | `team`.
- Added trusted npm publishing workflow with provenance (`publish-npm.yml`).
- Documented the v0.2.0 roadmap (measurement/cost + parallel desktop companion)
  and clarified npm vs source-checkout install paths in README / CONTRIBUTING /
  install docs.
- Expanded provider setup guidance for OpenAI-compatible endpoints (including
  DeepSeek) and global vs workspace config.
- Ignore `*.log` in the repository `.gitignore`.

## v0.1.0

- First formal release of `auto-talon` as a local-first personal agent for
  CLI/TUI daily work.
- **Pre-release upgrade note:** Users upgrading from source checkouts or preview
  builds with the legacy thread→session schema or JSON session transcripts must
  run `talon doctor --fix` once. Runtime no longer silently repairs the legacy
  schema on every open.
- `talon doctor` warns when deprecated `compact.bufferTokens` is set (field has no runtime effect).
- Added the `talon tui` daily agent surface, `talon run` / `talon continue`
  terminal workflows, and operational views for tasks, sessions, trace, audit,
  inbox, commitments, next actions, schedules, memory, skills, and provider
  status.
- Added governed shell/file execution with sandbox policy, explicit approvals,
  audit logs, trace events, and rollback artifacts.
- Added provider setup, selection, promotion, health checks, routing diagnostics,
  and smoke tests for the supported provider catalog.
- Added Feishu/Lark and local webhook gateway adapters plus MCP client/server
  surfaces for configured tools and skill resources.
- Added local-state bootstrap scripts (`scripts/setup.sh`, `scripts/setup.ps1`)
  and `talon init`.
- Added release convergence features: versioned DB migrations, config version
  migration, package metadata checks, npm pack dry-run validation, and
  `talon release check`.
- Expanded scripted smoke/eval fixtures for release regression scenarios.
- Hardened completion verification: a verification command must actually run a
  test/build/lint/typecheck (or `node --test` / a `test`/`verify`/`check`
  script). Bare package managers (`npm`), arbitrary scripts (`node src/app.js`),
  echoed commands (`echo npm test`), and long-lived `process` sessions no longer
  count as verification evidence, and configured test commands match by exact or
  prefixed invocation instead of loose substring matching.
- Hardened OpenAI-compatible text `<tool_call>` fallback parsing: argument values
  are kept as strings unless they are JSON strings (so `write_file` content is no
  longer coerced into objects/numbers), and markup is only executed when the
  response is primarily a tool call rather than prose that documents the format.
  Nested `</arg_value>` / `</tool_call>` inside argument content now resolves to
  the last matching closer before the next sibling tag.
- Provider-reported timeouts retry once and the "at most once" recovery marker is
  now restored from trace on resume so a process restart cannot re-trigger it.
  Task-level inactivity/wall-clock timeouts remain terminal by design.
- Eval reporting: required `workspace_diff` misses without an out-of-scope path
  are now classified as verification failures instead of `unknown`, and
  `talon eval acceptance` runs the reliability-acceptance suite with
  verification-completion and workspace-scope gate thresholds. `talon release
  check` runs this acceptance gate when given a real provider.
- Approved the xfyun-coding / astron-code-latest reliability-acceptance baseline
  under `fixtures/eval-baselines/xfyun-coding-astron-code-latest.json`.
- Added user, developer, troubleshooting, compatibility, and security
  documentation for the v0.1.0 release scope.
- Known limits: Node.js 20 is not supported; Slack, Telegram, and Discord
  adapters are not included; real provider runs require user-supplied provider
  credentials; AutoTalon is local-first and not a hosted multi-tenant service.

# Provider Routing and Budget Policy

This runtime policy makes model selection and spend control explicit at execution time.

## Routing Modes

- `cheap_first`: prefer the cheap tier for main generation.
- `balanced`: prefer the balanced tier for main generation.
- `quality_first`: prefer the quality tier for main generation.

Helper routes are configured separately (`summarize`, `classify`, `recallRank`) and can be pinned to a tier or set to `null`.

## Budget Units and Limits

Budgets track both:

- token usage (`usedInput`, `usedOutput`)
- USD usage (`usedCostUsd`)

Both task and session scopes support soft/hard limits:

- soft breach -> trace/audit warning + downgrade to cheap tier
- hard breach -> fail fast with `budget_exceeded`

## Cost Accounting

Provider cost uses pricing entries from `runtime.config.json`:

- `inputPerMillion`
- `outputPerMillion`
- `cachedInputPerMillion` (optional)

If pricing for a provider is missing, token accounting still works and USD is skipped for that provider call.

When the provider reports cache-hit usage, the runtime records `cachedInputTokens`
and can price them with `cachedInputPerMillion`. See
[Prompt cache accounting](dev/prompt-cache.md) for what is measured today, where
to inspect `cost_report`, and how Anthropic `cache_control` breakpoints are
emitted on the stable prefix.

## Trace and Audit Visibility

Routing and budget behavior is observable through:

- trace: `route_decision`, `budget_warning`, `budget_exceeded`, `cost_report`
- audit: `route_decided`, `budget_warning`, `budget_exceeded`

## CLI

- `talon provider route --mode <cheap_first|balanced|quality_first>`
- `talon provider stats --by <provider|session|task|mode>`
- `talon budget show --task <taskId>`
- `talon budget show --session <sessionId>`

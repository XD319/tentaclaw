# Prompt Cache Accounting

AutoTalon already has an end-to-end path for **measuring** cached prompt tokens.
Creating cache hits (especially Anthropic `cache_control` breakpoints) is tracked
separately and is not fully enabled yet.

## What is measured today

When a provider response carries cache-hit usage, the runtime stores it as
`cachedInputTokens` on `ProviderUsage` and propagates it through:

| Layer | Role |
| --- | --- |
| Provider telemetry | Aggregates `cachedInputTokens` across successful requests |
| Budget recorder | Emits a `cost_report` trace event per provider turn |
| Cost calculator | Optionally prices cached tokens via `cachedInputPerMillion` |
| Provider stats / eval / replay | Surface or sum the same field for diagnostics |

Relevant code:

- `src/runtime/budget/cost-calculator.ts`
- `src/runtime/kernel/budget-recorder.ts`
- `src/providers/provider-telemetry.ts`

### Cost formula

USD cost for a turn is:

```
(inputTokens / 1e6) * inputPerMillion
+ (outputTokens / 1e6) * outputPerMillion
+ (cachedInputTokens / 1e6) * cachedInputPerMillion   # only when both are set
```

If `cachedInputPerMillion` is omitted, or `cachedInputTokens` is absent, the
cached component is treated as `0`. Missing provider pricing still allows token
accounting; USD is skipped for that call.

Configure pricing under `.auto-talon/runtime.config.json`:

```json
{
  "budget": {
    "pricing": {
      "anthropic": {
        "inputPerMillion": 3,
        "outputPerMillion": 15,
        "cachedInputPerMillion": 0.3
      }
    }
  }
}
```

Exact knobs follow the schema in [provider routing and budget](../provider-routing-budget.md).
Use your provider's published cached-input rate when you want USD reports to
reflect cache hits.

## Where to look

- **Traces:** `cost_report` events include `cachedInputTokens` (and computed USD
  when pricing is present). Inspect with `talon trace <task_id> --summary` or the
  full JSON trace.
- **Provider stats:** `talon provider stats` aggregates usage that includes
  cached tokens when the upstream reported them.
- **Eval / replay:** token summaries include cached-input totals when available.

If `cachedInputTokens` stays `0` while you expect hits, either the upstream did
not report cache fields, or another provider transport has not mapped them yet.
OpenAI-compatible responses map `prompt_tokens_details.cached_tokens`,
`prompt_cache_hit_tokens`, and top-level `cached_tokens` into `cachedInputTokens`.

## What is (and is not) triggered today

| Behavior | Status |
| --- | --- |
| Record `cachedInputTokens` when present on usage | Implemented |
| Price cached tokens via `cachedInputPerMillion` | Implemented |
| Emit Anthropic `cache_control` breakpoints on stable prefixes | Not yet — tracked in [#9](https://github.com/XD319/auto-talon/issues/9) |
| Guarantee OpenAI-compatible cache-hit field mapping | Implemented for common OpenAI-compatible fields (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, `cached_tokens`) |
| Prompt prefix “stable → variable” ordering for hit rate | Roadmap M2 (pairs with `#9`) |

Today, cache hits are recorded when they **happen to appear** in provider usage.
AutoTalon does not yet proactively create Anthropic prompt-cache breakpoints.

## Expected configuration once Anthropic `cache_control` lands

After [#9](https://github.com/XD319/auto-talon/issues/9) (and any required
maintainer spec for breakpoints / `anthropic-beta` headers):

1. Keep pricing `cachedInputPerMillion` set for Anthropic-compatible providers so
   `cost_report` USD reflects cheaper cached reads.
2. Prefer long-lived stable prefixes (system prompt, tool schemas, stable memory)
   ahead of turn-variable content so breakpoints can stick.
3. Re-run a real Anthropic-compatible task and confirm non-zero
   `cachedInputTokens` on later turns in `cost_report` / provider stats.
4. Treat first-turn cache writes as setup cost; measure savings on subsequent
   turns with the same stable prefix.

Expected savings depend on the provider’s cached-input price versus normal
input price and on how often the stable prefix is reused. Documented rates
belong in your provider’s pricing page; AutoTalon only multiplies reported
cached tokens by `cachedInputPerMillion`.

## Related docs

- [Provider routing and budget](../provider-routing-budget.md) — routing modes,
  budget limits, and pricing fields
- [Context window management](context-window.md) — compaction and input limits
  (orthogonal to prompt-cache pricing, but both affect spend)
- [ROADMAP M2](../../ROADMAP.md#m2--lower-token-cost) — caching work items

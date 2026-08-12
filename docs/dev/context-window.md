# Context Window Management

auto-talon manages long sessions with a two-tier context pipeline inspired by Codex, Claude Code, and Hermes Agent.

## Tiers

1. **Micro-compaction (every provider call)** — prunes old tool results (keeps the latest 5) and enforces per-result tool output budgets with artifact spill.
2. **Macro-compaction (headroom threshold)** — summarizes the middle of the conversation into a decision-oriented handoff packet, preserves a token-budget tail, and rehydrates pinned recent files.

## Context window resolution

Context window size is resolved in this priority order:

1. **Explicit `tokenBudget.inputLimit`** in `runtime.config.json` or env — overrides everything
2. **`providers.<name>.contextWindowTokens`** in `provider.config.json` — user override
3. **Per-model manifest** — built-in `MODEL_CONTEXT_WINDOWS` map keyed by provider + model name (with prefix matching for versioned model IDs)
4. **Provider manifest default** — static `contextWindowTokens` on the provider entry

Providers without a known context window (`xfyun-coding`, `openai-compatible`, `ollama`, `openrouter`) require explicit configuration via `provider setup --context-window-tokens`, `tokenBudget.inputLimit`, or `tokenBudget.unknownContextWindowFallback` (default `32000` in `runtime.config.json`).

`talon doctor` warns when the active provider is missing `contextWindowTokens` and no explicit input limit is configured.

## Token accounting

Hybrid counting combines the last provider `inputTokens` with a conservative char/4 × 1.33 estimate for messages added since that API call.

Macro-compaction triggers when estimated prompt tokens reach:

```
inputLimit * thresholdRatio
```

Default `thresholdRatio` is `0.5` (Hermes-style 50% threshold).

Resume hygiene compaction (on session continue) uses a separate threshold:

```
inputLimit * hygieneThresholdRatio
```

Default `hygieneThresholdRatio` is `0.85`.

Context usage percentage in the TUI is computed against the **usable** window:

```
(inputLimit - reservedOutput)
```

Prompt-cache hits are a separate spend signal (`cachedInputTokens` /
`cachedInputPerMillion`), not a substitute for context-window limits. See
[Prompt cache accounting](prompt-cache.md).

## Configuration (`.auto-talon/runtime.config.json`)

```json
{
  "compact": {
    "thresholdRatio": 0.5,
    "hygieneThresholdRatio": 0.85,
    "tailTokenBudget": 20000,
    "tailMinMessages": 10,
    "resumeUserTailMessages": 6,
    "messageThreshold": 100,
    "iterationThreshold": 24,
    "toolCallThreshold": 40,
    "summarizer": "provider_subagent"
  },
  "contextRetention": {
    "maxFiles": 8,
    "maxBytesPerFile": 24000,
    "maxTotalBytes": 128000,
    "maxTotalBytesUnderGuard": 200000,
    "toolOutputMaxTokens": 2500
  }
}
```

`compact.bufferTokens` is **deprecated** and has **no runtime effect**. If set to a value greater than zero, `talon doctor` reports a warning — remove the field and rely on `tokenBudget` plus `compact.thresholdRatio` (with the built-in compaction safety margin) instead.

## Summarizer modes

- `deterministic` — rule-based structured summary (no provider call).
- `provider_subagent` — LLM handoff summary via `routing.helpers.summarize`. Uses the **helper provider's** context window for pre-flight checks, not the main agent's. Failures are traced and surfaced; switch to `deterministic` if the helper provider is unavailable.

## Artifacts

Oversized tool outputs spill to `.auto-talon/artifacts/<taskId>/<toolCallId>.txt`. The model receives a preview plus the recovery path.

## Comparison

| Feature | Codex | Claude Code | Hermes | auto-talon |
|---------|-------|-------------|--------|------------|
| Tool output cap | token + spill | clear old results | prune before summarize | token + spill |
| Compact trigger | context pressure | ~95% headroom | 50% tokens | `inputLimit * thresholdRatio` (default 50%) |
| Resume hygiene | N/A | N/A | N/A | `inputLimit * hygieneThresholdRatio` (default 85%) |
| Context window source | model API | model API | model mapping | model map → provider manifest → user config |
| Tail protection | N/A | recent files | token tail | token tail + pinned files |
| Summary style | truncate-first | structured sections | handoff packet | decision-oriented handoff |

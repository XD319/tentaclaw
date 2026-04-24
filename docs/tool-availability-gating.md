# Tool Availability Gating

`ToolExposurePlanner` separates runtime tool registration from per-iteration tool exposure.

## Metadata

Each tool now declares:

- `riskLevel`
- `costLevel`
- `sideEffectLevel`
- `approvalDefault`
- `toolKind`

This metadata enables policy-style gating before tools are sent to provider schemas.

## Availability Checks

Tools can optionally implement:

`checkAvailability(context) -> { available, reason }`

If absent, the default is available.

## Exposure Rules

Per iteration, the planner evaluates:

1. Profile allowlist membership.
2. Availability check outcome.
3. High-risk first-iteration suppression unless mutation intent is explicit.
4. Budget soft-downgrade behavior (expensive tools get `costWarning`).
5. Thread pending-decision state (mutation tools hidden).

## Trace

Planner emits `tool_exposure_decided` with:

- exposed tool names
- hidden tool names
- per-tool reasons

Sample: `fixtures/tool-exposure/tool_exposure_decided.sample.json`.

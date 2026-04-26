# Tool Availability Gating

`ToolExposurePlanner` separates runtime tool registration from per-iteration tool visibility decisions.

## Metadata

Each tool now declares:

- `riskLevel`
- `costLevel`
- `sideEffectLevel`
- `approvalDefault`
- `toolKind`

This metadata supports stable tool visibility, budget hints, and downstream governance decisions.

## Availability Checks

Tools can optionally implement:

`checkAvailability(context) -> { available, reason }`

If absent, the default is available.

## Exposure Rules

Per iteration, the planner evaluates:

1. Availability check outcome.
2. Budget soft-downgrade behavior (expensive tools get `costWarning`).

Runtime profiles no longer hide tools by intent, first-iteration risk, or pending-decision state. Mutation and external actions stay visible to the model and are governed at execution time by policy, sandbox checks, and approval flow.

## Trace

Planner emits `tool_exposure_decided` with:

- exposed tool names
- hidden tool names
- per-tool reasons

Typical reasons:

- `eligible`
- `budget downgrade active`
- `unavailable: <reason>`

Sample: `fixtures/tool-exposure/tool_exposure_decided.sample.json`.

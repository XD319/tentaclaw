# Tentaclaw Phase 1

Tentaclaw is an Agent Runtime MVP focused on a CLI-first, governance-friendly execution kernel. Phase 1 boots the runtime core, tool orchestration, SQLite-backed persistence, and trace schema v1 without introducing a web UI or framework-heavy agent stack.

## Phase 1 Capabilities

- TypeScript strict-mode Node.js runtime with a thin CLI entry.
- Single-agent execution kernel with provider abstraction and a built-in `MockProvider`.
- Structured tool orchestration for:
  - `file_read`: read file, list directory, keyword search
  - `file_write`: write file, update file, simplified patch application
  - `shell`: restricted shell command execution with cwd/env/timeout controls
- SQLite persistence for tasks, traces, tool calls, artifacts, and run metadata.
- Trace schema v1 with replayable execution chains.
- Vitest coverage for runtime loop success/failure paths and policy boundaries.

## Project Layout

```text
src/
  agents/
  cli/
  memory/
  policy/
  runtime/
  storage/
  tools/
  tracing/
  types/
test/
```

## Install

```bash
corepack pnpm install
```

## CLI Usage

```bash
corepack pnpm dev run "read README.md"
corepack pnpm dev task list
corepack pnpm dev task show <task_id>
corepack pnpm dev trace <task_id>
corepack pnpm dev config doctor
```

After building, the compiled CLI entry is `dist/cli/index.js` and the binary name is `agent`.

## Runtime Flow

1. CLI parses arguments and delegates to the application service.
2. The execution kernel creates a persisted task and run metadata record.
3. Provider input is assembled from task context, memory context, tool catalog, and token-budget placeholders.
4. Provider responses either:
   - finish the task,
   - request a retry, or
   - request one or more tool calls.
5. Tool calls are executed only through the orchestrator, which validates schema, applies policy, persists tool-call state, and emits trace events.
6. Tool outputs are fed back into the provider loop until the task succeeds, fails, times out, or is interrupted.

## Trace Schema v1

Every trace row contains:

- `eventId`
- `taskId`
- `sequence`
- `timestamp`
- `eventType`
- `stage`
- `actor`
- `summary`
- `payload`

Supported `eventType` values:

- `task_created`
- `task_started`
- `model_request`
- `model_response`
- `tool_call_requested`
- `tool_call_started`
- `tool_call_finished`
- `tool_call_failed`
- `loop_iteration_completed`
- `retry`
- `interrupt`
- `final_outcome`

Use `agent trace <task_id>` to print the ordered event chain for a persisted task.

## Current Limits

- Provider integration is mock/scripted only. Real LLM providers are intentionally deferred.
- Memory plane is a bounded placeholder and does not persist memories yet.
- Shell policy is intentionally conservative and based on a minimal allowlist/denylist.
- File patching is a simplified text replacement flow, not a full unified-diff engine.
- The project uses Node's experimental `node:sqlite` module to avoid leaking SQL outside the repository layer.

## Development Commands

```bash
corepack pnpm install
./node_modules/.bin/tsc.cmd -p tsconfig.json
./node_modules/.bin/vitest.cmd run
./node_modules/.bin/eslint.cmd .
```

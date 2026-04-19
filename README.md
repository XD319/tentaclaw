# auto-talon Phase 5

auto-talon is an Agent Runtime MVP focused on a CLI-first, governance-friendly execution kernel. Phase 5 keeps the same runtime core, retains the Ink terminal UI, and adds a dedicated Gateway / Adapter layer so external entrypoints can be attached without leaking platform logic into runtime, memory, policy, tools, or repositories.

## Phase 5 Capabilities

- TypeScript strict-mode Node.js runtime with a thin CLI entry.
- Ink-based TUI with panel navigation and timed refresh.
- Gateway / Adapter abstraction with explicit lifecycle, capability declaration, session mapping, and identity mapping.
- Local webhook adapter as the first non-CLI/TUI external entrypoint.
- Adapter-aware trace and audit source attribution.
- Capability downgrade notices instead of silent platform mismatch failures.
- Single-agent execution kernel with provider abstraction, a built-in `MockProvider`, and a real `GLM` provider integration.
- Shared runtime skeleton for `planner`, `executor`, and `reviewer` profiles.
- Memory plane with typed `session`, `project`, and `agent` scopes.
- Selective recall with source explanation and context policy filtering.
- Session compact that summarizes long conversations instead of replaying them in full.
- Snapshot metadata for governed memory inspection and comparison.
- Memory quality controls with `candidate`, `verified`, `stale`, and `rejected` states.
- Privacy and retention controls through `sourceType`, `privacyLevel`, and `retentionPolicy`.
- Structured tool orchestration for:
  - `file_read`: read file, list directory, keyword search
  - `file_write`: write file, update file, simplified patch application
  - `shell`: restricted shell execution with workspace/cwd/env/timeout boundaries
  - `web_fetch`: allowlisted HTTP fetch through the sandbox
- Policy plane with typed `allow`, `allow_with_approval`, and `deny` decisions.
- Approval flow with persisted pending approvals, reviewer identity, timestamps, and timeouts.
- SQLite persistence for tasks, traces, tool calls, approvals, audit logs, artifacts, checkpoints, and run metadata.
- Separate trace and audit views so execution reconstruction and governance inspection stay distinct.
- TUI query models that expose runtime state without letting Ink components touch repositories directly.

## Project Layout

```text
src/
  gateway/
  approvals/
  audit/
  agents/
  cli/
  memory/
  policy/
  profiles/
  runtime/
  sandbox/
  storage/
  tui/
  tools/
  tracing/
  types/
test/
docs/
```

## Install

```bash
corepack pnpm install
```

## CLI Usage

```bash
corepack pnpm dev run "write notes.txt :: hello" --profile executor
corepack pnpm dev tui
corepack pnpm dev task list
corepack pnpm dev task show <task_id>
corepack pnpm dev trace <task_id>
corepack pnpm dev audit <task_id>
corepack pnpm dev gateway serve-webhook --port 7070
corepack pnpm dev approve pending
corepack pnpm dev approve allow <approval_id>
corepack pnpm dev approve deny <approval_id>
corepack pnpm dev provider list
corepack pnpm dev provider current
corepack pnpm dev provider test
corepack pnpm dev config doctor
corepack pnpm dev memory list
corepack pnpm dev memory show project --cwd .
corepack pnpm dev memory snapshot create project --cwd . --label phase3-baseline
corepack pnpm dev memory review <memory_id> verified
```

After building, the compiled CLI entry is `dist/cli/index.js` and the binary name is `agent`.

## Local Webhook Adapter

Phase 5 adds a minimal external HTTP entrypoint for boundary validation.

Start it with:

```bash
corepack pnpm dev gateway serve-webhook --port 7070
```

Then use:

```bash
curl -X POST http://127.0.0.1:7070/tasks ^
  -H "Content-Type: application/json" ^
  -d "{\"taskInput\":\"summarize runtime status\",\"requester\":{\"externalSessionId\":\"local-session\",\"externalUserId\":\"local-user\",\"externalUserLabel\":\"Local User\"}}"
```

Available endpoints:

- `POST /tasks`
- `GET /tasks/:taskId`
- `GET /tasks/:taskId/events`

## TUI Usage

Start the chat-style Ink TUI from the same workspace database used by the CLI:

```bash
corepack pnpm dev:tui
# or
corepack pnpm dev tui --cwd .
```

The chat TUI is the primary interactive surface. It submits prompts, streams runtime trace activity into the transcript, surfaces approval cards, and keeps CLI-created task state in the same `.auto-talon/agent-runtime.db` database.

Keyboard controls:

- `Enter`: send the current prompt
- `Alt+Enter` / `Ctrl+J`: insert a newline
- `Ctrl+C`: interrupt the running task, or exit when idle
- `Ctrl+P` / `Ctrl+N`: navigate prompt history
- `PageUp` / `PageDown`: scroll the transcript
- `Ctrl+G`: jump to the top of the transcript
- `Ctrl+T`: collapse or expand activity lines
- `a`: approve the pending approval when the input is empty
- `d`: deny the pending approval when the input is empty
- `q`: quit when the input is empty

Slash commands:

- `/help`: show chat commands and shortcuts
- `/clear`: clear the visible conversation without deleting persisted tasks
- `/new`: start a fresh visible chat session
- `/stop`: request interruption of the running task
- `/title <name>`: set the chat session label in the banner
- `/history`: show recent prompt history
- `/status`: show session, provider, task, approval, and scroll state

The dashboard remains available as a separate observability and approval surface:

```bash
corepack pnpm dev:dashboard
# or
corepack pnpm dev dashboard --cwd .
```

Dashboard controls:

- `1-6`: jump to a panel
- `Tab` / `Shift+Tab`: switch panels
- `Up` / `Down`: move within the current list
- `[` / `]`: switch selected task from any panel
- `a`: approve the selected approval
- `d`: deny the selected approval
- `r`: refresh immediately
- `q`: quit

## CLI And TUI Responsibilities

CLI remains the command surface for explicit operations such as:

- running tasks
- listing and showing tasks
- viewing raw trace and audit output
- scripting approval and memory workflows

TUI remains the observation and governance surface for:

- watching task state change over time
- spotting failed or approval-blocked runs quickly
- resolving approvals interactively
- reviewing trace, diff, memory-hit, and error summaries in one place

The runtime core, storage, policy, memory, and tool orchestration logic still live outside the TUI. Ink components only render view models and invoke application-service actions.

## Gateway And Adapter Responsibilities

Gateway exists outside Runtime Core and is responsible for:

- protocol adaptation
- adapter capability declaration
- capability downgrade handling
- external identity to runtime identity mapping
- external session to task mapping
- trace and audit source stamping

Adapters do not:

- read or write memory directly
- evaluate policy
- invoke tools directly
- access repositories directly

They only enter the system through a unified gateway runtime API.

## Runtime Flow

1. CLI parses arguments and delegates to the application service.
2. The execution kernel creates a persisted task and run metadata record.
3. The selected agent profile contributes its prompt and tool whitelist.
4. Provider input is assembled from task context, filtered memory context, tool catalog, and token-budget placeholders.
5. Tool calls are executed only through the orchestrator, which:
   - validates input,
   - prepares a sandboxed execution plan,
   - evaluates policy,
   - requests approval when needed,
   - persists tool-call state,
   - records trace and audit events.
6. If approval is needed, the task moves to `waiting_approval`, a checkpoint is stored, and the CLI can later resume the task through `agent approve allow <approval_id>`.
7. Tool outputs are fed back into the provider loop until the task succeeds, fails, times out, or is rejected.

## Provider Configuration

Current real provider support:

- `xfyun-coding`
  - lightweight preset built on the shared `openai-compatible` transport
  - dedicated preset for the iFLYTEK Coding Plan OpenAI-compatible endpoint
  - defaults to `https://maas-coding-api.cn-huabei-1.xf-yun.com/v2`
  - defaults to the `astron-code-latest` model
  - should not be pointed at the standard `maas-api` endpoint
- `glm`
  - integrated through the runtime's unified `Provider` interface
  - uses an OpenAI-compatible HTTP contract behind the provider boundary
- `openai-compatible`
  - generic OpenAI-compatible HTTP provider for vendors that expose `chat/completions` and `/models`
  - intended for providers such as Kimi / MiniMax / DeepSeek style compatible gateways when their API surface matches
- `mock`
  - remains available for local development and deterministic tests

The runtime core does not import any vendor SDK directly. Provider selection is resolved in a separate configuration layer and injected during bootstrap.

When a new vendor already speaks an existing transport, prefer configuration over adding a new runtime class:

- use built-in presets such as `xfyun-coding`, `glm`, or `moonshot` when available
- use `openai-compatible` / `anthropic-compatible` style settings for vendors that match those APIs
- use `customProviders` to register project-local presets without editing code

Configuration sources:

- environment variables
- `.auto-talon/provider.config.json`

Environment variables:

- `AGENT_PROVIDER`
- `AGENT_PROVIDER_MODEL`
- `AGENT_PROVIDER_BASE_URL`
- `AGENT_PROVIDER_API_KEY`
- `AGENT_PROVIDER_TIMEOUT_MS`
- `AGENT_PROVIDER_MAX_RETRIES`

Example config file:

```json
{
  "currentProvider": "xfyun-coding",
  "providers": {
    "xfyun-coding": {
      "apiKey": "your-api-key",
      "baseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
      "model": "astron-code-latest",
      "timeoutMs": 30000,
      "maxRetries": 2
    },
    "glm": {
      "apiKey": "your-api-key",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "model": "glm-4.5-air",
      "timeoutMs": 30000,
      "maxRetries": 2
    },
    "openai-compatible": {
      "apiKey": "your-api-key",
      "baseUrl": "https://your-compatible-provider.example/v1",
      "model": "your-model-id",
      "timeoutMs": 30000,
      "maxRetries": 2
    },
    "mock": {
      "model": "mock-default"
    }
  }
}
```

Example custom preset without changing runtime code:

```json
{
  "currentProvider": "vendor-coding",
  "customProviders": {
    "vendor-coding": {
      "transport": "openai-compatible",
      "displayName": "Vendor Coding",
      "baseUrl": "https://vendor.example.com/v1",
      "model": "vendor-code-latest",
      "timeoutMs": 30000,
      "maxRetries": 2
    }
  },
  "providers": {
    "vendor-coding": {
      "apiKey": "your-api-key"
    }
  }
}
```

`customProviders` currently supports:

- `transport`: `openai-compatible` or `anthropic-compatible`
- `displayName`
- `providerLabel`
- `anthropicVersion` for Anthropic-compatible gateways
- `baseUrl`
- `model`
- `timeoutMs`
- `maxRetries`
- `apiKey`

Switching providers:

- use `AGENT_PROVIDER=mock` for the mock provider
- use `AGENT_PROVIDER=xfyun-coding` for the iFLYTEK Coding Plan preset
- use `AGENT_PROVIDER=glm` for the real GLM provider
- use `AGENT_PROVIDER=openai-compatible` for OpenAI-compatible vendors
- confirm the active selection with `agent provider current`
- verify connectivity with `agent provider test`
- run `agent config doctor` for a broader environment and provider check

Doctor and provider test currently check:

- whether an API key is configured
- whether the endpoint is reachable
- whether a model is configured
- whether the configured model appears in `/models` when available

## Provider Trace Fields

Provider calls now emit structured trace events:

- `provider_request_started`
- `provider_request_succeeded`
- `provider_request_failed`

Each event includes:

- provider name
- model name
- latency in milliseconds
- retry count
- usage metadata when available
- error category on failures

Secrets are not written into trace or audit payloads. API keys stay inside the provider configuration layer.

## Memory Plane

Phase 3 adds three memory scopes:

- `session`
  - active task goal, compact summaries, recent tool outputs
- `project`
  - workspace-level reusable facts and outcomes
- `agent`
  - reusable profile/user hints across tasks

Memory is not injected wholesale. Recall is selective and explainable:

- keyword overlap and task semantics drive candidate selection
- confidence and freshness affect ranking
- stale memories are downgraded
- rejected memories are blocked
- conflicting memories are marked instead of replacing prior records
- all recalled fragments pass through the context policy filter before prompt assembly

Each memory record includes:

- `memoryId`
- `scope`
- `source`
- `sourceType`
- `privacyLevel`
- `retentionPolicy`
- `confidence`
- `status`
- `createdAt`
- `updatedAt`
- `lastVerifiedAt`
- `expiresAt`
- `supersedes`
- `conflictsWith`

Memory states:

- `candidate`
- `verified`
- `stale`
- `rejected`

Minimal review flow:

- `agent memory review <memory_id> verified`
- `agent memory review <memory_id> stale`
- `agent memory review <memory_id> rejected`

## Context Boundary Rules

Phase 3 makes information boundaries explicit in both persistence and context assembly.

- all memory fragments carry `sourceType`, `privacyLevel`, and `retentionPolicy`
- restricted content is blocked from automatic long-term (`project` / `agent`) memory writes
- restricted long-term recall is blocked from model context by default
- persisted trace/audit previews redact restricted tool output
- session compact stores distilled summaries instead of replaying all raw turns
- snapshot metadata is viewable without replaying all memory content

## Policy Rules

Phase 2 uses a local rule configuration through `src/policy/default-policy-config.ts`. Each rule has:

- `id`
- `description`
- `priority`
- `effect`
- `match`

Supported match fields:

- `users`
- `workspaces`
- `agentProfiles`
- `toolNames`
- `capabilities`
- `riskLevels`
- `privacyLevels`
- `pathScopes`

Current defaults:

- deny any tool request that escapes workspace boundaries
- deny `reviewer` writes and shell execution
- require approval for `filesystem.write`, `shell.execute`, and `network.fetch`
- allow workspace-scoped `filesystem.read`

## Approval Flow

Approval state is stored separately from tool calls and includes:

- requester id
- reviewer id
- request time
- decision time
- timeout
- decision result

Task and tool-call state expectations:

- task enters `waiting_approval` while a gated action is pending
- tool call enters `awaiting_approval`
- approval allow resumes the kernel from a persisted checkpoint
- approval deny or timeout fails the task and marks the tool call as `denied` or `timed_out`

CLI control surface:

- `agent approve pending`
- `agent approve allow <approval_id>`
- `agent approve deny <approval_id>`

## Audit Log vs Trace

Trace is for replaying task execution. It captures the ordered decision chain of a run, including provider calls, policy decisions, approval events, sandbox outcomes, and tool execution milestones.

Audit log is for governance inspection. It captures policy decisions, high-risk requests, approvals, sandbox enforcement, file writes, shell execution, web fetches, gateway source events, and rejection/failure events in a compliance-oriented view.

Use:

- `agent trace <task_id>` for execution reconstruction
- `agent trace context <task_id>` for explainable context assembly, recall, filter, and reviewer trace debugging
- `agent audit <task_id>` for governance/audit inspection

## Reviewer Profile

`reviewer` shares the same runtime kernel as other profiles but is intentionally constrained:

- prompt is review-focused
- tool whitelist is read-oriented
- policy denies write and shell capabilities

This keeps reviewer behavior controlled without introducing multi-agent swarm logic.

## Additional Notes

- The runtime still uses Node's experimental `node:sqlite` module to keep SQL inside repository boundaries.
- `web_fetch` is sandboxed behind an allowlist and defaults to `example.com` in the bootstrap config for the MVP.
- Approval TTL defaults to 5 minutes and is configurable through bootstrap config.
- GLM integration currently targets the OpenAI-compatible chat completions flow and reserves a streaming interface, but end-to-end streaming delivery is not yet wired through the runtime loop.
- Provider health checks rely on the provider `/models` endpoint when available; if an endpoint omits model listing, reachability can still pass while model availability remains unknown.
- The current TUI is intentionally lightweight but interactive: chat mode is the primary task authoring surface, while dashboard mode remains focused on observation and approval review.
- The local webhook adapter is intentionally small and is not a Slack/Telegram/Discord replacement.
- Phase 5 focuses on extension boundaries first; full chat-platform and MCP integrations are deferred until the adapter contract is proven.
- Diff inspection is summary-first. It highlights risky change shapes but does not yet implement a full unified diff viewer.
- TUI state refresh is polling-based for the MVP; there is no event-stream transport yet.
- See [docs/phase2-governance.md](/D:/Backup/Career/Projects/AgentProject/auto-talon/docs/phase2-governance.md) for the Phase 2 governance notes.
- See [docs/phase3-memory.md](/D:/Backup/Career/Projects/AgentProject/auto-talon/docs/phase3-memory.md) for the Phase 3 memory design.
- See [docs/phase5-gateway.md](/D:/Backup/Career/Projects/AgentProject/auto-talon/docs/phase5-gateway.md) for the Phase 5 gateway and adapter design.

## Development Commands

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

## Continuous Integration

The repository now includes a GitHub Actions workflow at `.github/workflows/ci.yml`.

Every `push` and `pull_request` runs the same shared verification entrypoint used locally:

```bash
corepack pnpm check
```

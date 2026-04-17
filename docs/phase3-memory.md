# Phase 3 Memory Plane

Phase 3 adds a governed memory plane to the CLI-first runtime. The goal is not unlimited recall, but typed, explainable, auditable memory that respects privacy and retention boundaries.

## Three Memory Scopes

- `session`
  - Scope key: current `taskId`
  - Purpose: active task goals, compacted conversation state, recent tool outcomes
  - Default use: allowed in model context after context filtering
- `project`
  - Scope key: current workspace `cwd`
  - Purpose: reusable workspace knowledge and task outcomes
  - Default use: selectively recalled by keyword overlap
- `agent`
  - Scope key: `${requesterUserId}:${agentProfileId}`
  - Purpose: reusable operator/profile hints across tasks
  - Default use: selectively recalled by keyword overlap

## Memory Record Shape

Each memory record is strongly typed and persisted through the repository layer. Core fields:

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

Supporting fields include `title`, `content`, `summary`, `keywords`, `scopeKey`, and `metadata`.

## Status Lifecycle

- `candidate`
  - Default for auto-generated long-term memory and tool-derived observations
- `verified`
  - Used for task goals, session compact summaries, or manually reviewed records
- `stale`
  - Applied when memory expires or is manually downgraded
- `rejected`
  - Used when a memory is wrong and must not re-enter recall/context

Minimal review flow:

- `agent memory review <memory_id> verified`
- `agent memory review <memory_id> stale`
- `agent memory review <memory_id> rejected`

## Selective Recall

Recall does not inject all stored memory. The memory plane:

1. gathers candidates from `session`, `project`, and `agent`
2. scores them with:
   - keyword overlap
   - confidence
   - freshness / staleness
3. explains each score with source metadata
4. applies the context policy filter before any fragment enters model context

Trace records a `memory_recalled` event so `agent trace <task_id>` can show what was selected or blocked.

## Session Compact

When the active session grows beyond the configured threshold, the runtime creates a typed `session_compact` memory and replaces older messages with a shorter summary message plus the newest turns. This preserves:

- task goal
- important tool results
- meaningful constraints

without replaying the entire conversation back into the prompt.

## Snapshot

Snapshots persist lightweight metadata about a memory scope at a point in time.

- Create: `agent memory snapshot create <scope>`
- Inspect metadata: `agent memory show <scope>`

Each snapshot stores:

- snapshot id
- scope + scope key
- label
- creator
- creation time
- referenced memory ids
- summary metadata

## Privacy and Retention Boundaries

`privacyLevel`

- `public`
  - safe for broad reuse
- `internal`
  - usable in normal project/agent recall flows
- `restricted`
  - blocked from automatic long-term memory writes
  - blocked from cross-session model injection by default
  - redacted in persisted trace/audit previews

`retentionPolicy`

- `ephemeral`
  - do not retain beyond immediate processing
- `session`
  - valid only for the active task/session
- `project`
  - reusable in the current workspace
- `agent`
  - reusable across tasks for the same user/profile

Boundary rules:

- restricted content does not auto-write into `project` or `agent` memory
- recalled fragments must pass the context policy filter
- rejected memory never enters context
- stale memory is downgraded during ranking
- conflicting memory is flagged instead of overwriting earlier memory

## CLI Surface

- `agent memory list`
- `agent memory show <scope>`
- `agent memory snapshot create <scope>`
- `agent memory review <memory_id> <verified|rejected|stale>`

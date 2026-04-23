# Phase 3 Memory Plane

Phase 3 adds a governed memory plane to the CLI-first runtime. The goal is not unlimited recall, but typed, explainable, auditable memory that respects privacy and retention boundaries.

Task outcomes, review feedback, and failure lessons now live first in `ExperiencePlane`; see `docs/experience-plane.md`. They enter `MemoryPlane` only after an accepted experience is explicitly promoted.

## Five Memory Layers

- `working`
  - Scope key: current `taskId`
  - Purpose: active runtime memory from execution checkpoint context
  - Default use: runtime-only layer; shown in `memory show working`
- `project`
  - Scope key: current workspace `cwd`
  - Purpose: reusable workspace knowledge and task outcomes
  - Default use: selectively recalled by keyword overlap
- `profile`
  - Scope key: `${requesterUserId}:${agentProfileId}`
  - Purpose: reusable operator/profile hints across tasks
  - Default use: selectively recalled by keyword overlap
- `experience_ref`
  - Scope key: workspace `cwd`
  - Purpose: read-only projection of `ExperiencePlane` records
  - Default use: selectable as compressed references during relevant recall
- `skill_ref`
  - Scope key: workspace `cwd`
  - Purpose: read-only projection of enabled skill metadata
  - Default use: selectable as lightweight metadata hints; full body still requires `skill_view`

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

- `talon memory review <memory_id> verified`
- `talon memory review <memory_id> stale`
- `talon memory review <memory_id> rejected`

## Selective Recall

Recall does not inject all stored memory. `RecallPlanner` now coordinates retrieval across layers:

1. builds an enriched query from:
   - thread goal
   - current objective
   - next actions
   - tool plan
   - current task input
2. gathers candidates from `working`, `project`, `profile`, `experience_ref`, and `skill_ref`
3. scores candidates with:
   - keyword overlap
   - confidence
   - freshness / staleness
4. estimates token usage per candidate (`ceil(text.length / 4)`)
5. applies `RecallBudgetPolicy` and `MemorySelector` to keep only top-weighted candidates under token budget
6. records per-item explain fields: `reason`, `score`, `token_estimate`, `scope`

Trace now records a `recall_explain` event so `talon trace <task_id>` can show:

- why an item was selected
- why an item was skipped (usually budget)
- budget vs actual token usage per round

## Session Compact

When the active session grows beyond the configured threshold, the runtime creates a typed `session_compact` memory and replaces older messages with a shorter summary message plus the newest turns. This preserves:

- task goal
- important tool results
- meaningful constraints

without replaying the entire conversation back into the prompt.

## Snapshot

Snapshots persist lightweight metadata about a memory scope at a point in time.

- Create: `talon memory snapshot create <scope>`
- Inspect metadata: `talon memory show <scope>`

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
- `working`
  - valid only for the active task/session
- `project`
  - reusable in the current workspace
- `profile`
  - reusable across tasks for the same user/profile

Boundary rules:

- restricted content does not auto-write into `project` or `profile` memory
- task outcomes and failure lessons do not auto-write into long-term memory
- recalled fragments must pass the context policy filter
- rejected memory never enters context
- stale memory is downgraded during ranking
- conflicting memory is flagged instead of overwriting earlier memory

## CLI Surface

- `talon memory list`
- `talon memory show <scope>`
- `talon memory snapshot create <scope>`
- `talon memory review <memory_id> <verified|rejected|stale>`

## Trace And Audit Samples

- `fixtures/memory-layered/memory_recalled.sample.json`
- `fixtures/memory-layered/recall_explain.sample.json`
- `fixtures/memory-layered/memory_written.sample.json`
- `fixtures/memory-layered/audit_review_resolved.sample.json`

Cost-aware routing and budget controls are documented in `docs/provider-routing-budget.md`.

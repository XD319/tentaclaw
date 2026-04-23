# Experience Plane

`ExperiencePlane` stores reusable operational lessons separately from prompt-facing `MemoryPlane` records.

The plane is an asset pool for task outcomes, reviewer feedback, failure lessons, conventions, gotchas, decisions, patterns, and preference signals. Records are captured as candidates, reviewed by a human or reviewer workflow, and only promoted after acceptance.

## Boundaries

- `MemoryPlane` remains the only source for prompt-facing recall.
- `ExperiencePlane` records are not injected into model context by default.
- Task outcomes and failure lessons no longer write directly to long-term project or agent memory.
- Promotion is explicit and only allowed from `accepted` experience records.
- `skill_candidate` promotion stores metadata only; it does not create a marketplace entry or generate a skill.
- The recall path is keyword and structured-signal based. There is no embedding provider, semantic vector path, or vector store.

## Record Shape

Experience records include:

- type: `decision`, `pattern`, `convention`, `gotcha`, `task_outcome`, `review_feedback`, `failure_lesson`, `preference_signal`
- source: `task`, `tool_result`, `reviewer`, `delegation`, `session_end`, `manual_import`
- status: `candidate`, `accepted`, `promoted`, `rejected`, `stale`
- scope and paths
- confidence and value score
- optional promotion target
- provenance for task, tool, trace, reviewer, and source label
- keywords, keyword phrases, structured index signals, and metadata

## Recall

`RecallEngine` ranks experience candidates with a fixed pipeline:

1. structured filters
2. keyword and phrase matching
3. status, confidence, and value score weighting

Index signals include tokens, phrases, type, source, status, scope, paths, error codes, reviewers, task status, and value score.

## Lifecycle Capture

The execution kernel publishes lifecycle trace events. `ExperienceCollector` subscribes to trace and creates candidate records for:

- `task_success`
- `task_failure`
- `review_resolved`
- `pre_compress`
- `session_end`
- `delegation_complete`
- tool success and failure trace events

The collector is deliberately separate from the kernel so experience extraction can evolve without adding business logic to the execution loop.

## CLI

- `talon experience list`
- `talon experience show <experience_id>`
- `talon experience review <experience_id> <accepted|rejected|stale>`
- `talon experience promote <experience_id> <project_memory|profile_memory|skill_candidate>`
- `talon experience search <query>`

List and search support filters for type, source, status, value score, task id, reviewer, scope, and scope key.

## Dashboard

The dashboard includes an `experience` panel with captured records for the selected task. It shows type, source, status, value score, promotion target, provenance, and matching score when a search trace exists.

## Relation To Layered Memory

- `experience_ref` is a read-only layer exposed by `talon memory list/show`.
- Experience entries remain out of prompt recall until they are explicitly promoted.

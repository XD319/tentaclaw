# Commands

Core:

- `agent run`
- `agent tui`
- `agent dashboard`
- `agent init`
- `agent doctor`
- `agent version`

Operational:

- `agent task list|show|timeline`
- `agent trace [task_id] [--summary]`
- `agent audit <task_id> [--summary]`
- `agent approve pending|allow|deny`

Subsystems:

- `agent provider list|current|test|stats`
- `agent memory list|show|snapshot|review`
- `agent experience list|show|review|promote|search`
- `agent skills list|view|enable|disable|draft|promote`
- `agent gateway serve-webhook|serve-feishu|list-adapters`
- `agent mcp list|ping|serve`

Release / diagnostics:

- `agent replay <task_id> [--dry-run]`
- `agent eval run [--explain]`
- `agent eval smoke`
- `agent eval beta`
- `agent release check` (maintainer-only; run from the auto-talon repository root)

# Commands

Core:

- `talon run`
- `talon continue --last|--thread <id> [task]`
- `talon tui`
- `talon dashboard`
- `talon init`
- `talon doctor`
- `talon version`

Operational:

- `talon task list|show|timeline`
- `talon thread list|show|archive|snapshots <thread_id>|snapshot <snapshot_id>`
- `talon schedule create|list|show|pause|resume|run-now|runs|run`
- `talon inbox [--status <status>]`
- `talon inbox list|show|done|dismiss`
- `talon commitments list|show|create|block|unblock|complete|cancel`
- `talon next list|add|done|block|unblock|resume`
- `talon trace [task_id] [--summary]`
- `talon trace context <task_id>`
- `talon audit <task_id> [--summary]`
- `talon approve pending|allow|deny`
- `talon workspace map|rollback`
- `talon repo map` (deprecated alias)

Subsystems:

- `talon provider list|current|test|stats|route`
- `talon budget show --task <id>|--thread <id>`
- `talon memory list|show|search|snapshot|review`
- `talon experience list|show|review|promote|search`
- `talon skills list|view|enable|disable|draft|promote|rollback`
- `talon gateway serve-webhook|serve-feishu|list-adapters`
- `talon mcp list|ping|serve`
- `talon sandbox`
- `talon config doctor`

Release / diagnostics:

- `talon replay <task_id> [--dry-run]`
- `talon eval run [--explain]`
- `talon eval smoke` (compatibility alias)
- `talon smoke run`
- `talon eval beta`
- `talon release check` (maintainer-only; run from the auto-talon repository root)

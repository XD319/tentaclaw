# Config Reference

All config files live under `.auto-talon/` and include `version`.

- `provider.config.json`
- `runtime.config.json`
- `sandbox.config.json`
- `gateway.config.json`
- `feishu.config.json`
- `mcp.config.json`
- `mcp-server.config.json`
- `skill-overrides.json`

Create defaults with:

```bash
talon init --yes
```

Run validation with:

```bash
talon doctor
```

SQLite runtime schema now includes thread continuity tables:

- `threads` for first-class thread/session containers
- `thread_runs` for each task run linked to a thread
- `thread_lineage` for branch/compress/archive lineage events
- `thread_snapshots` for structured compact/resume state (goal, open loops, blocked reason, next actions, memory links, capabilities)
- `schedules` for persisted one-shot/interval/cron schedule definitions
- `schedule_runs` for queued/running/completed/failed execution attempts, retry records, and task/thread traceability

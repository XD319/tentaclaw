# Quickstart

1. Initialize workspace: `talon init --yes`
2. Open Personal Assistant workspace: `talon tui`
3. Start or continue work from today/inbox/thread views inside the TUI
4. Open runtime Ops view when needed: `talon ops` (`talon dashboard` is a compatibility alias)
5. Optional: connect a chat entry point with `talon gateway serve-feishu --cwd .`

Useful checks:

- `talon continue --last`
- `talon run "summarize this project"`
- `talon task list`
- `talon trace <task_id> --summary`
- `talon audit <task_id> --summary`

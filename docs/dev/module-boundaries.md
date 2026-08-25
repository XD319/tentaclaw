# Module Boundaries

- `runtime/`: composition root, execution lifecycle, app service.
- `providers/`: provider config + transport adapters.
- `tools/`: tool implementations and orchestration.
- `policy/`: allow/approval/deny decision rules.
- `gateway/`: external ingress adapters.
- `storage/`: SQLite migrations and repositories only.
- `tui/`: presentation and interaction only.
- `session-api/`: loopback HTTP for the web workspace and integrations.

Boundary rules:

- Gateway must not bypass runtime service/repositories.
- TUI must not query repositories directly.
- Web UI (`web/`) and `session-api` must not import `storage` or `tui`.
- Providers do not persist data directly.

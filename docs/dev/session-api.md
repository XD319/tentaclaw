# Session HTTP API

The session API is the loopback contract for the browser workspace (`talon web`)
and for integrations. `talon web` serves the Vite UI from the same process and
sets an HttpOnly cookie; `talon session-api serve` exposes JSON only.

## Start

```bash
talon web --host 127.0.0.1 --port 7080
talon session-api serve --host 127.0.0.1 --port 7080
```

Browser clients authenticate with the `talon_http` cookie set on `GET /`.
Integrations can still send `Authorization: Bearer`.

## Workspace endpoints

- `GET /v1/bootstrap` — workspace, provider status, catalog (no secrets)
- `POST /v1/providers/setup` / `POST /v1/providers/use`
- `POST /v1/sessions` / `POST /v1/sessions/:id/turns` (202 `{ taskId }`)
- `GET /v1/tasks/:id/events` — SSE (`output`, `trace`)
- `POST /v1/tasks/:id/stop`
- `GET /v1/sessions/:id/changes` / `POST /v1/artifacts/:id/rollback`
- `GET /v1/approvals/pending` / `POST /v1/approvals/:id/resolve`
- `GET /v1/clarify/pending` / `POST /v1/clarify/:id/answer`
- Inbox, memory, schedules, commitments, next actions, skills, experiences, tasks/trace

## Endpoints

```bash
talon session-api serve --host 127.0.0.1 --port 7080
```

## Endpoints

### `GET /v1/sessions`

List indexed sessions.

Query params:

- `ownerUserId`
- `status` (`active`, `archived`, `deleted`)

### `GET /v1/sessions/:id`

Return session metadata plus runtime detail.

### `GET /v1/sessions/:id/messages`

Return canonical TUI-visible messages and UI state metadata.

### `GET /v1/sessions/search?q=`

Full-text search across stored session messages.

### `POST /v1/sessions/:id/continue`

Non-interactive continue endpoint.

Body:

```json
{ "input": "Pick up where we left off." }
```

Response:

```json
{
  "taskId": "...",
  "status": "succeeded",
  "output": "..."
}
```

## Notes

- All endpoints bind to localhost by default.
- Session ids are runtime `session_id` values shared by TUI, CLI, and gateway entry points.
- Legacy `.auto-talon/sessions/*.json` transcripts are migrated into SQLite by `talon doctor --fix` (one-time).

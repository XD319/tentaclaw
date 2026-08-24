# Quickstart

Install first: pick the **user (npm)** or **developer (from source)** path in the
[README Install](../../README.md#install) section (or [Install](install.md)).
This quickstart assumes the user path (`talon ...`). From a source checkout,
replace `talon` with `corepack pnpm dev`.

## No-credentials mock walkthrough

Use this path on a fresh machine when you want to reach `talon tui` without an
API key. Mock replies are deterministic demos for local smoke — not a real model.

1. Confirm Node.js: `node -v` must print `>=22.13.0` (Node 20 is not supported
   because runtime storage uses built-in `node:sqlite`).
2. Install and initialize:

```bash
npx auto-talon
```

Or the CLI-only walkthrough:

```bash
npm install -g auto-talon
talon init --yes
talon provider setup mock
talon provider test
talon run "say hello"
talon tui
```

3. Inside the TUI, send a short message. You should get a mock reply and be able
   to open today/inbox/session views. Open runtime Ops with `talon ops` when
   needed (`talon dashboard` is a compatibility alias).

`provider test` and `talon run` should succeed with no credentials. If either
fails with a missing-key or provider error, re-run `talon provider setup mock`
and confirm `talon provider status` shows `mock` as active.

### Common first-run blockers

| Symptom | Fix |
| --- | --- |
| Unsupported Node / `node:sqlite` errors | Install Node.js `>=22.13.0` and reopen the shell |
| `talon: command not found` after `npm install -g` | Put npm's global bin directory on `PATH` (or use `npx auto-talon ...`), then reopen the shell |
| Setup asks for an API key or fails on missing credentials | You selected a real provider; switch with `talon provider setup mock` |
| Code search later is slow or warns about `rg` | Optional: install ripgrep; see [Windows troubleshooting](windows-troubleshooting.md). Mock first-run does not require `rg` |
| Unclear workspace / migration state | Run `talon doctor`. If it reports legacy thread/session tables or pending JSON transcripts, follow the printed fix (`talon doctor --fix`) and re-check with `talon doctor`. |

## Real provider path

After the mock walkthrough (or instead of it):

1. Configure a reusable user provider:
   `talon provider setup openai --api-key "$OPENAI_API_KEY"`
2. Verify: `talon provider test`
3. Open the personal agent TUI: `talon tui`
4. Start or continue work from today/inbox/session views inside the TUI
5. Optional: connect a chat entry point with `talon gateway serve-feishu --cwd .`

`talon provider setup` writes user config by default, so configured providers are
visible from any workspace directory in `/model`. Use
`talon provider setup <provider> --workspace` only when a project needs a local
override, `talon provider use <provider>` to switch a saved user selection,
`talon provider promote` to copy the current effective project provider into user
defaults, and `talon provider status` to see which layer is active. Environment variables such as `AGENT_PROVIDER` and
`AGENT_PROVIDER_API_KEY` still take precedence when you prefer env-managed
credentials.

First-time remote provider setup should select the real model and base URL when
the built-in defaults are not the endpoint you use. Slow coding/tool turns can
also set the request timeout explicitly, for example
`talon provider setup openai-compatible --base-url <url> --model <model> --api-key <key> --timeout-ms 120000`.
Run `talon provider smoke` to exercise the post-tool model turn with the active
provider.

Inside `talon tui`, switch among already-configured providers with `/model`
(for example `/model deepseek:deepseek-chat`). The list is global-first: user-level
providers appear in every workspace, with `[user]`, `[workspace override]`, or
`[workspace-only]` labels when relevant. Use `/model <selection> --global`
to persist the choice to user config, or `--workspace` for a project override.
An explicit `/model` switch overrides `routing.providers` for the main model (budget
downgrade to the cheap tier still applies when soft limits are hit). Auxiliary slots
configured as `auto` reuse the current main provider, so they update immediately after
a switch. Aliases work for switching, but saved config stores the resolved provider name.
If `AGENT_PROVIDER` is set in the environment, it can still override saved config on
the next process start.
Configure providers outside the session with `talon model`, `talon provider setup`,
or `talon provider custom add`.

Commands started from a subdirectory of an initialized project reuse the
nearest parent `.auto-talon/` directory. Use `--cwd` or
`AGENT_WORKSPACE_ROOT` when you want to pin a project root explicitly.
`mock` remains available for tests and demos, but it must be selected
explicitly.

Useful checks:

- `talon continue --last`
- `talon run "summarize this project"`
- `talon task list`
- `talon trace <task_id> --summary`
- `talon audit <task_id> --summary`

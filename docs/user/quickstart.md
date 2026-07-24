# Quickstart

Install first: pick the **user (npm)** or **developer (from source)** path in the
[README Install](../../README.md#install) section (or [Install](install.md)).
This quickstart assumes the user path (`talon ...`). From a source checkout,
replace `talon` with `corepack pnpm dev`.

1. Initialize local agent state: `talon init --yes`
2. Configure a reusable user provider: `talon provider setup openai --api-key "$OPENAI_API_KEY"`
3. Open the personal agent TUI: `talon tui`
4. Start or continue work from today/inbox/session views inside the TUI
5. Open runtime Ops view when needed: `talon ops` (`talon dashboard` is a compatibility alias)
6. Optional: connect a chat entry point with `talon gateway serve-feishu --cwd .`

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


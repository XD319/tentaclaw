# Provider Troubleshooting

auto-talon does not depend on official provider SDK packages. Built-in providers use Node.js
`fetch` with OpenAI-compatible or Anthropic-compatible HTTP transports, so provider behavior is
validated through configuration, endpoint reachability, and response-shape checks.

Supported built-in providers include:

- `mock`
- `openai`
- `anthropic`
- `gemini`
- `openrouter`
- `ollama`
- `glm`
- `moonshot`
- `minimax`
- `qwen`
- `xai`
- `xfyun-coding`
- `openai-compatible`

Custom providers can be configured with `customProviders` when they expose either an
`openai-compatible` or `anthropic-compatible` transport.

- Missing key: set `AGENT_PROVIDER_API_KEY` or re-run
  `talon provider setup <provider> --api-key <key>`, then `talon provider test`.
- Endpoint unreachable: check `baseUrl` and network policy; update with
  `talon provider setup <provider> --base-url <url>`.
- Model unavailable: run `talon provider test` and change `model` with
  `talon provider setup <provider> --model <model>`.
- Unknown context window (`Context Window Tokens: -`): set
  `talon provider setup <provider> --context-window-tokens <n>` when budget/compaction
  behavior looks wrong.
- Unsupported provider name: verify `currentProvider` / `customProviders`.
- No provider configured: try `talon provider setup mock` for a no-credentials demo,
  or configure a real provider with `--api-key`.

Common configuration knobs:

- Environment: `AGENT_PROVIDER`, `AGENT_PROVIDER_API_KEY`, `AGENT_PROVIDER_BASE_URL`, `AGENT_PROVIDER_MODEL`, `AGENT_PROVIDER_TIMEOUT_MS`, `AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS`, `AGENT_PROVIDER_MAX_RETRIES`
- User defaults: `~/.auto-talon/provider.config.json`
- Workspace overrides: `.auto-talon/provider.config.json`
- User config directory override: `AGENT_USER_CONFIG_DIR`
- Current provider selector: `currentProvider`
- Provider-specific entries: `providers` with optional `credentials` pools
- Custom HTTP-compatible entries: `customProviders`
- Model aliases for `/model`: `modelAliases`
- Fallback provider chain: `fallbackProviders` and structured `fallback.main` / `fallback.auxiliary.<slot>`
- Auxiliary model slots: `.auto-talon/runtime.config.json` `auxiliary`

In `talon tui`, `/model` shows the active model source and a numbered list of
already-configured selectable models. Use `/model 1` to switch by number,
`/model <provider:model>` or `/model <alias>` to switch by selection,
`/model status` for the detailed view, and `/model default` to clear the active
session override. Session overrides are strict: if the chosen provider/model is
not configured, the command reports the error instead of using a hidden
fallback.

Provider visibility is global-first: user-level providers in
`~/.auto-talon/provider.config.json` appear in every workspace. Workspace config
can override fields for the current project or add workspace-only custom
providers. Use `talon model`, `talon provider setup`, or
`talon provider custom add` to add providers and credentials outside the
session.

CLI and API diagnostics use the same model view:

- `talon model list --json`
- `talon model status --json`
- `talon model set <selection> --session <session-id>`
- `talon model clear --session <session-id>`
- `GET /v1/models?sessionId=<id>`
- `PATCH /v1/sessions/:id/model`

Model routing notes:

- `runtime.config.json` `routing.providers` selects tiered main providers when no explicit session model selection or runtime switch is active.
- A session override is stored in session metadata and wins over `routing.providers` until `/model default` or `talon model clear --session <id>` clears it.
- Auxiliary slots in `runtime.config.json` `auxiliary` set to `auto` follow the current main provider.
- `modelAliases` can be used with `/model`, but persisted config writes the resolved provider name.
- `AGENT_PROVIDER` is applied at startup before workspace/user defaults; env-only selections are shown in status but are not persistable by `/model`.
- Effective precedence is: session override, explicit runtime switch, `routing.providers`, environment startup config, workspace config, user config.

New workspaces do not choose `mock` automatically. If diagnostics show
`Provider: unconfigured`, run `talon provider setup <provider>` to save a user
default, or select a provider through `AGENT_PROVIDER`. Keep workspace overrides
only where a project needs them. Select `mock` explicitly for tests or demos.
If a workspace already has the right endpoint and model, run
`talon provider promote` there to make that effective provider config the user
default for new workspaces.

Credential pool notes:

- Existing `apiKey` entries still work and become the `default` credential when no `credentials` array is present.
- Prefer `credentials[].apiKeyEnv` for additional keys. `talon doctor` checks workspace config for plaintext secrets and reports only field paths.
- `talon model status --json` shows credential status and available credential ids without printing secret values.
- Failover rotates through additional available credentials for the active provider/model before moving to fallback providers.

Fallback notes:

- `fallbackProviders` remains supported for existing config files.
- `fallback.main` is the structured main fallback chain.
- `fallback.auxiliary.<slot>` overrides fallback order for auxiliary slots such as summarizers or reviewers.
- Runtime status appears in `talon model status` under `fallback.status` after a fallback attempt.

Provider manifest notes:

- Place JSON manifests in `~/.auto-talon/providers/` for user-wide providers or `.auto-talon/providers/` for workspace providers.
- Manifests declare provider-owned defaults such as transport, base URL, default model, context window, and streaming/tool-call support.
- Configure keys separately through `providers.<name>.apiKey` or `providers.<name>.credentials`; manifests should not contain secrets.
Diagnostics:

- `talon provider status`
- `talon provider test`
- `talon provider smoke`
- `talon doctor`

When a tool succeeds and the next provider turn fails with `timeout_error`,
check `talon provider status` first. Older explicit remote provider entries may
still carry a `30000` request timeout; `status` and `doctor` warn about that
without rewriting it. Update the active config layer with
`talon provider setup <provider> --timeout-ms 120000` and use
`talon provider smoke` to exercise a synthetic post-tool turn. For streaming
providers, raise `--stream-idle-timeout-ms` only when the response starts but
then goes silent between chunks.



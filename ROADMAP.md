# Roadmap

[English](ROADMAP.md) | [简体中文](ROADMAP.zh-CN.md)

This roadmap describes the direction for the next release after `v0.1.0`. It is a
living document: priorities may shift as evals and user feedback arrive.

- Current release: `v0.1.1` (see [CHANGELOG.md](CHANGELOG.md))
- Next target: `v0.2.0`
- Theme: **Trustworthy self-improvement, at lower cost** — evolution you can
  measure — **∥ desktop companion** (parallel product surface).

## How to read this document

Each work item is tagged so contributors can quickly find where they can help:

- **Ownership**
  - `maintainer` — requires a design decision, touches security/governance core,
    or needs paid real-model validation. Not outsourced.
  - `community` — well-scoped and self-contained; open to external contributors.
  - `mixed` — spec is decided by a maintainer, implementation can be claimed.
- **Difficulty**: `good-first-issue`, `intermediate`, `advanced`.
- **Paid model**: whether verifying the change requires a real (paid) provider,
  or can be validated with the mock / scripted-smoke providers.

If you want to pick something up, comment on the tracking issue to claim it before
starting, and read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Why these directions

`v0.1.0` is already a mature local-first agent (sandbox, approvals, trace, audit,
rollback, memory, experience, scheduler, gateways, MCP). Two concrete gaps shape
this release:

1. **Cost: caching is measured but never triggered.** The runtime accounts for
   `cachedInputTokens` end to end (cost calculator, budget, telemetry, replay,
   eval), but the Anthropic-compatible provider does not emit `cache_control`
   breakpoints — so caches are recorded when they happen but never proactively
   created. Closing this is low-risk and high-ROI.
2. **Quality: the self-improvement loop is unverified.** `ExperiencePlane` and
   `PromotionAdvisor` (auto-promoting skills from repeated successful patterns)
   exist, but the eval suite only measures blind capability. Nothing measures the
   compounding loop: *experience captured → promoted → performance actually
   improves*.

Everything else follows from making that loop measurable, then using the same
measurement to prove cost and quality wins.

A third product gap is the lack of a graphical companion. `v0.2.0` adds a
**parallel** desktop track (Tauri shell + session-api sidecar) that does not
replace the TUI or the measurement/cost headline. See
[docs/dev/desktop-companion.md](docs/dev/desktop-companion.md).

## Dependency overview

```
M1 measurement backbone ─┬─→ M2 lower cost (prove savings with numbers)
                         └─→ performance work (prove gains with numbers)
M3 hardening = hygiene folded into every milestone
M4 adoption  = independent track, run if this release targets growth
M5 desktop companion = parallel track (Tauri + session-api; does not replace TUI)
```

Recommended sequencing: **run M1 and M2 in parallel** (M1 lays the backbone, M2
ships the high-ROI cost win), fold M3 in continuously, take on M4 if this release
targets adoption, and run **M5 in parallel** without blocking measurement/cost
release criteria.

---

## M1 — Measurement backbone

Goal: make "the agent got better" and "self-evolution helped" provable, not
asserted.

| Item | Ownership | Difficulty | Paid model | Notes |
| --- | --- | --- | --- | --- |
| Define "performance" as fixed eval metrics (success rate / avg rounds / tokens-per-success) and wire gate thresholds | `maintainer` | — | no | Design decision; sets the baseline everyone reports against. |
| Self-evolution **compounding eval** runner: run the same task set with an empty vs. accumulated experience/skill state and diff the metrics | `maintainer` | advanced | yes | Integrates eval core + experience plane; add a gate rule "self-evolution must not regress". |
| Expand the compounding eval **task dataset** (once the runner lands) | `community` | intermediate | no | Pure data work under the existing `EvalSuiteManifest` contract; each task needs at least one required deterministic scorer. |

References: `src/evaluation/`, `fixtures/eval-baselines/`,
[docs/dev/evaluation.md](docs/dev/evaluation.md),
[docs/experience-plane.md](docs/experience-plane.md).

## M2 — Lower token cost

Goal: cut token spend with prompt caching, and prove the reduction with numbers
(the accounting pipeline already surfaces it via `cost_report` and eval tokens).

| Item | Ownership | Difficulty | Paid model | Notes |
| --- | --- | --- | --- | --- |
| Emit `cache_control: { type: "ephemeral" }` breakpoints on the stable prefix (system prompt, tool schema, stable memory prefix) in the Anthropic-compatible provider | `mixed` | advanced | partial | Maintainer confirms breakpoint strategy and `anthropic-beta` header requirements; implementation is claimable. |
| Prompt **prefix stabilization** — order the prompt "stable → variable" to maximize cache hits | `mixed` | intermediate | no | Must not break existing compaction/tail protection. |
| OpenAI-compatible **cached-token accounting** audit — confirm the usage parser maps cache-hit fields into `cachedInputTokens` | `community` | intermediate | no | Telemetry-layer, self-contained, unit-testable. |
| Documentation for cache configuration and expected savings | `community` | good-first-issue | no | Docs only. |

References: `src/providers/anthropic-compatible-provider.ts` (request body around
the `system` + `messages` construction), `src/providers/provider-telemetry.ts`,
`src/runtime/budget/cost-calculator.ts`, `src/runtime/kernel/budget-recorder.ts`,
[docs/dev/context-window.md](docs/dev/context-window.md),
[docs/provider-routing-budget.md](docs/provider-routing-budget.md).

## M3 — Hardening

Goal: keep regressions out. Bug fixing is hygiene, not a pillar — individual bugs
have naturally clear boundaries and make good entry points.

| Item | Ownership | Difficulty | Paid model | Notes |
| --- | --- | --- | --- | --- |
| Regression fixes surfaced by eval / replay | `community` | good-first-issue → intermediate | varies | One bug per issue. |
| Any change to sandbox / approval / policy | `maintainer` | — | — | Security/governance core; not outsourced. |

References: [docs/user/replay-and-eval.md](docs/user/replay-and-eval.md),
[docs/beta-readiness.md](docs/beta-readiness.md).

## M4 — Lower the barrier to entry

Goal: reduce first-run friction. Run this track if `v0.2.0` targets adoption;
otherwise defer to a later release.

| Item | Ownership | Difficulty | Paid model | Notes |
| --- | --- | --- | --- | --- |
| ripgrep missing → graceful fallback and clear guidance | `community` | good-first-issue | no | Independent and testable. |
| `talon doctor --fix` migration experience improvements | `community` | intermediate | no | Clear boundary; cover with tests. |
| Interactive `provider setup` UX improvements | `community` | good-first-issue → intermediate | no | Low-risk UX. |
| Quickstart / README polish (no-credentials mock walkthrough) | `community` | good-first-issue | no | Docs; keep `README.md` and `README.zh-CN.md` in sync. |

References: [docs/user/quickstart.md](docs/user/quickstart.md),
[docs/user/windows-troubleshooting.md](docs/user/windows-troubleshooting.md),
`scripts/setup.ps1`.

## M5 — Desktop companion (parallel)

Goal: a local-first graphical companion that drives the **existing** Node
runtime through `session-api`, without a second kernel.

Stack (locked): Tauri 2 shell, Vite + React UI, `talon session-api serve` as
sidecar over loopback Bearer auth.

| Phase | Item | Ownership | Difficulty | Paid model | Notes |
| --- | --- | --- | --- | --- | --- |
| M5a | Scaffold `apps/desktop` (Tauri 2 + Vite/React), sidecar spawn, health check, token injection | `mixed` | advanced | no | [#11](https://github.com/XD319/auto-talon/issues/11). Spec in ADR; claim after maintainer confirmation. **Required**. |
| M5b | Read-only session browser and transcript viewer | `community` | intermediate | no | [#13](https://github.com/XD319/auto-talon/issues/13). Depends on API where needed. **Required**. |
| M5b API | Expose read-only ops views (tasks / trace / pending approvals) on session-api | `mixed` | intermediate | no | [#12](https://github.com/XD319/auto-talon/issues/12). Contract led by maintainer. |
| M5c | Approval queue + allow/deny via API (same PolicyEngine path as TUI) | `mixed` | advanced | no | [#14](https://github.com/XD319/auto-talon/issues/14). Security-sensitive; best-effort for v0.2. |
| M5d | Chat compose via session `continue` / new session (non-streaming first) | `community` | intermediate | no | [#15](https://github.com/XD319/auto-talon/issues/15). Stretch; streaming is a follow-up. |
| M5e | Windows packaging + first-run workspace picker | `mixed` | advanced | no | [#16](https://github.com/XD319/auto-talon/issues/16). Stretch; Windows first. |
| docs | Keep companion ADR / security boundaries accurate | `community` | good-first-issue | no | [#10](https://github.com/XD319/auto-talon/issues/10). ADR already landed. |

**v0.2.0 success bar for M5:** M5a + M5b required; M5c best-effort; M5d/M5e stretch
and must not block a measurement/cost-focused release.

Security red lines (not claimable): public binds, weakening HTTP auth, bypassing
approvals/sandbox, rewriting the kernel inside the shell.

References: [docs/dev/desktop-companion.md](docs/dev/desktop-companion.md),
[docs/dev/session-api.md](docs/dev/session-api.md), `src/session-api/server.ts`,
`src/core/http-auth.ts`.

---

## Contributor summary

Good places to start, roughly by increasing difficulty:

1. Quickstart / README polish (M4) — `good-first-issue`, docs.
2. ripgrep fallback and guidance (M4) — `good-first-issue`.
3. Interactive `provider setup` UX (M4) — `good-first-issue`.
4. Cache configuration docs (M2) — `good-first-issue`, docs.
5. OpenAI-compatible cached-token accounting audit (M2) — `intermediate`.
6. `doctor --fix` migration experience (M4) — `intermediate`.
7. Desktop read-only session browser (M5b, after API) — `intermediate`.
8. Desktop chat compose via `continue` (M5d) — `intermediate`.
9. Compounding eval dataset expansion (M1, after the runner lands) — `intermediate`.
10. Anthropic `cache_control` emission (M2) — `advanced`, spec confirmed by a maintainer first.
11. Desktop Tauri scaffold / packaging (M5a/M5e) — `advanced`, after ADR confirmation.

Maintainer-led (please do not open as claimable community issues that weaken
these boundaries):

- Performance-metric definition and gate thresholds (M1).
- Compounding eval runner architecture (M1).
- Any sandbox / approval / policy change that bypasses governance (M3 / M5).
- Public HTTP binds, auth removal, or a second execution kernel in the companion.

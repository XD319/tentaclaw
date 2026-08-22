# Replay and Eval

## Replay

```bash
talon replay <task_id>
talon replay <task_id> --provider mock --from-iteration 2
talon replay <task_id> --dry-run
```

## Eval

Smoke and eval are separate maintainer diagnostics for source checkouts.
Smoke uses the scripted provider for deterministic runtime regression checks:

```bash
talon smoke run --fixture fixtures/runtime-smoke-tasks.json
talon smoke run --tasks file-read,workspace-write
```

Capability eval requires a configured real provider and a versioned blind suite.
The scripted and mock providers are rejected:

```bash
talon eval run \
  --suite fixtures/eval-suites/internal-blind.v2.json \
  --provider openai \
  --repetitions 3 \
  --output eval-artifacts
```

Compare a reviewed run with the approved baseline, or approve a passing report:

```bash
talon eval compare --current eval-artifacts/eval-report.json --baseline fixtures/eval-baselines/openai-gpt-4o-mini.json
talon eval compare --current eval-artifacts/eval-report.json --baseline fixtures/eval-baselines/openai-gpt-4o-mini.json --allow-drift
talon eval baseline update --report eval-artifacts/eval-report.json --output fixtures/eval-baselines/openai-gpt-4o-mini.json
```

Validate suite oracles with no model calls:

```bash
talon eval validate-suite
talon eval freeze-memory-state --cwd <workspace> --output memory-state.json
```

`--judge-provider` enables an optional report-only LLM judge. It does not affect
the deterministic gate. `talon eval coding` and `talon eval smoke` remain
compatibility aliases and print deprecation warnings.
Because the scripted compatibility suite has no external hidden-test guarantee,
its legacy `gitReadyDiffRate` is reported as zero rather than claiming readiness.

See [Evaluation Architecture](../dev/evaluation.md) for suite, scorer, artifact,
baseline, memory compounding, and CI details.

For auto-talon maintainer release verification, run `talon release check` from the repository root.

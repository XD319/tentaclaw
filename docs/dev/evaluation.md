# Evaluation Architecture

Auto-talon separates deterministic runtime checks from model capability evaluation.

## Two layers

- `talon smoke run` executes the 15 scripted fixtures. It is fast, deterministic, and belongs in pull-request CI. Its result is a runtime regression signal, not an agent capability score.
- `talon eval run` executes a versioned blind suite (`fixtures/eval-suites/internal-blind.v2.json` by default) with a configured real provider. The runner creates a fresh workspace for each trial and does not expose task IDs, scorer definitions, reference material, or hidden test files to the model.
- `talon eval compounding` runs the same suite twice: once with an empty experience/skill overlay, then with accumulated project skills. It diffs success rate, pass^k, rounds, and tokens-per-success, and fails when self-evolution regresses.
- `talon eval validate-suite` checks that every task has an oracle that satisfies required scorers and that a null agent cannot pass. It makes no model calls and belongs in pull-request CI.

The first-party evaluation core is implemented in TypeScript under `src/evaluation`. It has no hosted evaluation-service dependency.

## Suite contract

`EvalSuiteManifest` records the suite, prompt, and tool-schema versions. Each task defines only the model input, profile, isolated workspace seed, approval behavior, tags, optional oracle, and external scorers. Every task must include at least one required deterministic scorer; `succeeded` runtime status alone cannot pass a trial.

Oracle fixtures live in `fixtures/eval-suites/task-oracles.json` and are merged by task id at load time. Hidden files are injected only after the agent finishes, and graders run in a copied workspace so leftover agent files cannot shadow tests.

Supported scorer families cover final file state, commands and hidden tests, workspace diff scope, final output, tool calls and arguments, trace invariants, and an optional non-blocking LLM judge. Harness errors are excluded from success-rate denominators; a run is invalid when they exceed 5%.

## Reports and gates

The JSON report captures the dataset and code SHA, provider/model, sampling parameters, runtime environment, repetitions, pass@k size, per-scorer evidence, changed paths, full trace, tokens, cost when pricing is available, latency, grouped metrics, and stability statistics. Artifact output also includes JUnit, Markdown, and one JSON document per task.

Baseline comparison uses these defaults:

- Reports must share suite version, dataset hash, repetitions, prompt/tool schema versions, and pass@k size unless `--allow-drift` is set.
- The run gate fails only for required scorer misses on `risk: high` or capabilities `policy` / `safety`, and for provider-configuration or harness-error invalid runs. Other required scorer misses affect trial `success` and the metrics below; they do not set `report.gate.passed` to false.
- A newly added task that is not fully passing blocks.
- Success-rate regression blocks when 95% Wilson intervals do not overlap and the current rate is lower.
- `pass^k` regression greater than 10 percentage points blocks.
- P95 latency or average-cost growth greater than 25% warns but does not block.
- `talon eval baseline update` also requires a minimum success rate (default 50%).

The LLM judge is report-only. It must not affect the deterministic gate. An unconfigured judge is recorded as `skipped`, not passed.

## Memory compounding eval

`fixtures/eval-suites/memory-compounding.v1.json` is a four-arm internal regression: cold (empty memory, recall enabled), warm (relevant memories), distractor (equal-count unrelated memories), and poisoned (stale memory that contradicts the workspace). Stage 1/2 recall probes run without a model via `runRecallProbe`. Stage 3 uses real-model trials and reports paired token/round/tool deltas with bootstrap intervals plus poison-following rate.

Export a live workspace into that fixture format with `talon eval freeze-memory-state --output memory-state.json`.

## Compounding self-evolution

`talon eval compounding` measures whether accumulated skills help rather than
hurt. Both phases use the same `EvalSuiteManifest` tasks and scorers.

- **Empty:** isolated eval workspace with no extra project skills.
- **Accumulated:** the same workspace seed plus files from
  `fixtures/eval-compounding/accumulated`. Tracked skill fixtures live under
  `skills/` and are mapped into `.auto-talon/skills` at runtime so they are not
  gitignored.
- **Gate:** accumulated success rate and pass^k must not drop more than the
  configured thresholds (defaults match baseline comparison: 5pp / 10pp).

The compounding dataset lives at
`fixtures/eval-suites/compounding-self-evolution.v1.json`. Tasks prefer
categories that can benefit from skill reuse and each includes at least one
required deterministic scorer. Schema validation and overlay loading do not
require a paid model; a real-provider run is needed to score capability.

## CI policy

Pull requests run unit tests, coverage, build checks, scripted smoke, and `eval validate-suite` without paid model calls. The optional weekly workflow runs a 12-task canary after a repository administrator explicitly enables real-model evaluation. Full-suite and memory-arm runs are `workflow_dispatch` only. Missing configuration produces an explicit skip instead of a passing result.

Once a real-model run is reviewed, approve it with:

```bash
talon eval baseline update \
  --report eval-artifacts/eval-report.json \
  --output fixtures/eval-baselines/openai-gpt-4o-mini.json
```

# Evaluation Architecture

Auto-talon separates deterministic runtime checks from model capability evaluation.

## Two layers

- `talon smoke run` executes the 15 scripted fixtures. It is fast, deterministic, and belongs in pull-request CI. Its result is a runtime regression signal, not an agent capability score.
- `talon eval run` executes a versioned blind suite with a configured real provider. The runner creates a fresh workspace for each trial and does not expose task IDs, scorer definitions, reference material, or hidden test files to the model.
- `talon eval compounding` runs the same suite twice: once with an empty experience/skill overlay, then with accumulated project skills. It diffs success rate, pass^k, rounds, and tokens-per-success, and fails when self-evolution regresses.

The first-party evaluation core is implemented in TypeScript under `src/evaluation`. It has no hosted evaluation-service dependency.

## Suite contract

`EvalSuiteManifest` records the suite, prompt, and tool-schema versions. Each task defines only the model input, profile, isolated workspace seed, approval behavior, tags, and external scorers. Every task must include at least one required deterministic scorer; `succeeded` runtime status alone cannot pass a trial.

Supported scorer families cover final file state, commands and hidden tests, workspace diff scope, final output, tool calls and arguments, trace invariants, and an optional non-blocking LLM judge. Hidden files are injected only after the agent finishes and before the grader command runs.

## Reports and gates

The JSON report captures the dataset and code SHA, provider/model, runtime environment, repetitions, per-scorer evidence, changed paths, full trace, tokens, cost when pricing is available, latency, and stability statistics. Artifact output also includes JUnit and one JSON document per task.

Baseline comparison uses these defaults:

- Any required scorer failure blocks.
- A newly added task that is not fully passing blocks.
- Success-rate regression greater than 5 percentage points blocks.
- `pass^k` regression greater than 10 percentage points blocks.
- P95 latency or average-cost growth greater than 25% warns but does not block.

The LLM judge is report-only. It must not affect the deterministic gate.

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

Pull requests run unit tests, coverage, build checks, and scripted smoke without paid model calls. The optional nightly workflow runs only after a repository administrator explicitly enables real-model evaluation and configures its protected environment. Missing configuration produces an explicit skip instead of a passing result.

Once a real-model run is reviewed, approve it with:

```bash
talon eval baseline update \
  --report eval-artifacts/eval-report.json \
  --output fixtures/eval-baselines/openai-gpt-4o-mini.json
```

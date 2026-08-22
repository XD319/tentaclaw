import { exec } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { ToolCallRecord, TraceEvent } from "../types/index.js";
import type { EvalScorer } from "./schema.js";
import type { EvalScorerResult, EvalScorerStatus } from "./types.js";

const execAsync = promisify(exec);

export interface EvalScorerContext {
  afterFiles: Map<string, string>;
  beforeFiles: Map<string, string>;
  output: string | null;
  toolCalls: ToolCallRecord[];
  trace: TraceEvent[];
  workspaceRoot: string;
  judge?: (input: { output: string; reference?: string; rubric: string }) => Promise<{
    evidence: string;
    passed: boolean;
    score: number;
  }>;
}

export async function evaluateScorer(scorer: EvalScorer, context: EvalScorerContext): Promise<EvalScorerResult> {
  try {
    switch (scorer.type) {
      case "file_state": return evaluateFileState(scorer, context);
      case "command": return await evaluateCommand(scorer, context);
      case "workspace_diff": return evaluateDiff(scorer, context);
      case "output": return evaluateOutput(scorer, context);
      case "tool_trace": return evaluateToolTrace(scorer, context);
      case "trace": return evaluateTrace(scorer, context);
      case "llm_judge": return await evaluateJudge(scorer, context);
    }
  } catch (error) {
    return result(scorer, false, 0, `scorer error: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function evaluateFileState(scorer: Extract<EvalScorer, { type: "file_state" }>, context: EvalScorerContext): EvalScorerResult {
  safeWorkspacePath(context.workspaceRoot, scorer.path);
  const snapshotPath = normalizePath(scorer.path);
  const exists = context.afterFiles.has(snapshotPath);
  if (exists !== scorer.exists) return result(scorer, false, 0, `expected exists=${scorer.exists}, actual=${exists}`);
  if (!exists) return result(scorer, true, 1, "file is absent as required");
  const content = context.afterFiles.get(snapshotPath) ?? "";
  const missing = scorer.contains.filter((value) => !content.includes(value));
  const forbidden = scorer.notContains.filter((value) => content.includes(value));
  const passed = missing.length === 0 && forbidden.length === 0;
  return result(scorer, passed, passed ? 1 : 0, passed ? "file state matched" : `missing=[${missing.join(", ")}] forbidden=[${forbidden.join(", ")}]`);
}

async function evaluateCommand(scorer: Extract<EvalScorer, { type: "command" }>, context: EvalScorerContext): Promise<EvalScorerResult> {
  let exitCode = 0;
  let output = "";
  for (const [path, content] of Object.entries(scorer.hiddenFiles)) {
    const target = safeWorkspacePath(context.workspaceRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  try {
    const commandResult = await execAsync(scorer.command, { cwd: context.workspaceRoot, timeout: scorer.timeoutMs, windowsHide: true });
    output = `${commandResult.stdout}${commandResult.stderr}`;
  } catch (error) {
    const commandError = error as { code?: number | string; stdout?: string; stderr?: string };
    exitCode = typeof commandError.code === "number" ? commandError.code : 1;
    output = `${commandError.stdout ?? ""}${commandError.stderr ?? ""}`;
  }
  const missing = scorer.outputContains.filter((value) => !output.includes(value));
  const passed = exitCode === scorer.expectedExitCode && missing.length === 0;
  return result(scorer, passed, passed ? 1 : 0, `exit=${exitCode}; missingOutput=[${missing.join(", ")}]; output=${output.slice(0, 500)}`);
}

function evaluateDiff(scorer: Extract<EvalScorer, { type: "workspace_diff" }>, context: EvalScorerContext): EvalScorerResult {
  const changed = changedPaths(context.beforeFiles, context.afterFiles);
  const allowed = new Set(scorer.allowedPaths.map(normalizePath));
  const outside = changed.filter((path) => !allowed.has(path));
  const missing = scorer.requiredPaths.map(normalizePath).filter((path) => !changed.includes(path));
  const passed = (!scorer.requireChanges || changed.length > 0) && outside.length === 0 && missing.length === 0;
  return result(scorer, passed, passed ? 1 : 0, `changed=[${changed.join(", ")}]; outside=[${outside.join(", ")}]; missing=[${missing.join(", ")}]`);
}

function evaluateOutput(scorer: Extract<EvalScorer, { type: "output" }>, context: EvalScorerContext): EvalScorerResult {
  const output = context.output ?? "";
  const missing = scorer.contains.filter((value) => !output.includes(value));
  const forbidden = scorer.notContains.filter((value) => output.includes(value));
  const passed = output.length >= scorer.minLength && missing.length === 0 && forbidden.length === 0;
  return result(scorer, passed, passed ? 1 : 0, `length=${output.length}; missing=[${missing.join(", ")}]; forbidden=[${forbidden.join(", ")}]`);
}

function evaluateToolTrace(scorer: Extract<EvalScorer, { type: "tool_trace" }>, context: EvalScorerContext): EvalScorerResult {
  const names = context.toolCalls.map((call) => call.toolName);
  const missing = scorer.requiredTools.filter((name) => !names.includes(name));
  const forbidden = scorer.forbiddenTools.filter((name) => names.includes(name));
  const argumentFailures = Object.entries(scorer.requiredArguments).filter(([toolName, expected]) =>
    !context.toolCalls.some((call) => call.toolName === toolName && partialMatch(call.input, expected))
  ).map(([toolName]) => toolName);
  const tooMany = scorer.maxCalls !== undefined && context.toolCalls.length > scorer.maxCalls;
  const passed = missing.length === 0 && forbidden.length === 0 && argumentFailures.length === 0 && !tooMany;
  return result(scorer, passed, passed ? 1 : 0, `tools=[${names.join(", ")}]; missing=[${missing.join(", ")}]; forbidden=[${forbidden.join(", ")}]; argumentFailures=[${argumentFailures.join(", ")}]`);
}

function evaluateTrace(scorer: Extract<EvalScorer, { type: "trace" }>, context: EvalScorerContext): EvalScorerResult {
  const events = context.trace.map((event) => event.eventType as string);
  const missing = scorer.requiredEvents.filter((event) => !events.includes(event));
  const forbidden = scorer.forbiddenEvents.filter((event) => events.includes(event));
  const passed = missing.length === 0 && forbidden.length === 0;
  return result(scorer, passed, passed ? 1 : 0, `missing=[${missing.join(", ")}]; forbidden=[${forbidden.join(", ")}]`);
}

async function evaluateJudge(scorer: Extract<EvalScorer, { type: "llm_judge" }>, context: EvalScorerContext): Promise<EvalScorerResult> {
  if (context.judge === undefined) return result(scorer, false, 0, "judge skipped: no judge provider configured", "skipped");
  const judged = await context.judge({ output: context.output ?? "", ...(scorer.reference !== undefined ? { reference: scorer.reference } : {}), rubric: scorer.rubric });
  return result(scorer, judged.passed, judged.score, judged.evidence);
}

function result(
  scorer: EvalScorer,
  passed: boolean,
  score: number,
  evidence: string,
  status?: EvalScorerStatus
): EvalScorerResult {
  return {
    evidence,
    id: scorer.id,
    passed,
    required: scorer.required,
    score,
    status: status ?? (passed ? "passed" : "failed"),
    type: scorer.type
  };
}

export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
}

function safeWorkspacePath(workspaceRoot: string, path: string): string {
  const absolute = resolve(workspaceRoot, path);
  const relativePath = relative(resolve(workspaceRoot), absolute);
  if (relativePath.startsWith("..") || relativePath.includes(":")) throw new Error(`Path escapes eval workspace: ${path}`);
  return absolute;
}

function normalizePath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => partialMatch((actual as Record<string, unknown>)[key], value));
}

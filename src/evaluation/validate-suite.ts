import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { JsonObject, ToolCallRecord, TraceEvent } from "../types/index.js";
import { loadEvalSuite, type EvalOracle, type EvalTask } from "./schema.js";
import { evaluateScorer } from "./scorers.js";
import { seedWorkspace, snapshotWorkspace } from "./workspace.js";

export interface SuiteValidationIssue {
  kind: "missing_oracle" | "oracle_failed" | "null_agent_passed";
  scorerId?: string;
  taskId: string;
  evidence: string;
}

export interface SuiteValidationReport {
  issues: SuiteValidationIssue[];
  passed: boolean;
  suiteId: string;
  suitePath: string;
  taskCount: number;
}

export async function validateEvalSuite(suitePath: string): Promise<SuiteValidationReport> {
  const suite = loadEvalSuite(suitePath);
  const issues: SuiteValidationIssue[] = [];
  for (const task of suite.tasks) {
    if (task.oracle === undefined) {
      issues.push({
        evidence: "task is missing an oracle fixture",
        kind: "missing_oracle",
        taskId: task.id
      });
      continue;
    }
    const oracleResults = await gradeWithOracle(task, task.oracle);
    for (const result of oracleResults.filter((item) => item.required && item.status !== "skipped" && !item.passed)) {
      issues.push({
        evidence: result.evidence,
        kind: "oracle_failed",
        scorerId: result.id,
        taskId: task.id
      });
    }
    const nullResults = await gradeWithOracle(task, {
      files: {},
      output: "",
      toolCalls: [],
      traceEvents: []
    });
    const required = nullResults.filter((item) => item.required && item.status !== "skipped");
    if (required.length > 0 && required.every((item) => item.passed)) {
      issues.push({
        evidence: "every required scorer passed with an empty agent",
        kind: "null_agent_passed",
        taskId: task.id
      });
    }
  }
  return {
    issues,
    passed: issues.length === 0,
    suiteId: suite.id,
    suitePath,
    taskCount: suite.tasks.length
  };
}

async function gradeWithOracle(task: EvalTask, oracle: EvalOracle) {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-eval-validate-"));
  try {
    await seedWorkspace(workspaceRoot, task.workspace.files);
    const beforeFiles = await snapshotWorkspace(workspaceRoot);
    await seedWorkspace(workspaceRoot, oracle.files);
    const afterFiles = await snapshotWorkspace(workspaceRoot);
    const now = new Date().toISOString();
    const toolCalls: ToolCallRecord[] = oracle.toolCalls.map((call, index) => ({
      errorCode: null,
      errorMessage: null,
      finishedAt: now,
      input: call.input as JsonObject,
      iteration: 1,
      output: null,
      requestedAt: now,
      riskLevel: "low",
      startedAt: now,
      status: "finished",
      summary: "oracle",
      taskId: "oracle",
      toolCallId: `oracle-${index + 1}`,
      toolName: call.toolName
    }));
    const trace = oracle.traceEvents.map((eventType, index) => ({
      actor: "oracle",
      eventId: `oracle-event-${index + 1}`,
      eventType,
      payload: {},
      sequence: index + 1,
      stage: "lifecycle",
      summary: eventType,
      taskId: "oracle",
      timestamp: now
    })) as unknown as TraceEvent[];
    const results = [];
    for (const scorer of task.scorers) {
      if (scorer.type === "llm_judge") {
        continue;
      }
      results.push(await evaluateScorer(scorer, {
        afterFiles,
        beforeFiles,
        output: oracle.output,
        toolCalls,
        trace,
        workspaceRoot
      }));
    }
    return results;
  } finally {
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

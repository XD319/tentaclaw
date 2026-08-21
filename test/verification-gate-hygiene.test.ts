import { describe, expect, it } from "vitest";

import { classifyFailure } from "../src/evaluation/runner.js";
import { isContentMutatingWrite, writeTargetPath } from "../src/runtime/kernel/tool-batch-executor.js";
import type { EvalScorerResult } from "../src/evaluation/types.js";
import type { ProviderToolCall, TraceEvent } from "../src/types/index.js";

const scorer = (
  type: string,
  passed: boolean,
  evidence: string,
  required = true
): EvalScorerResult => ({ evidence, id: type, passed, required, score: passed ? 1 : 0, type });

const runtimeStatus = (passed: boolean): EvalScorerResult =>
  scorer("runtime_status", passed, `task status=${passed ? "succeeded" : "failed"}`);

const toolCall = (toolName: string, input: ProviderToolCall["input"] = {}): ProviderToolCall => ({
  input,
  reason: `${toolName} call`,
  toolCallId: `${toolName}-call`,
  toolName
});

describe("classifyFailure", () => {
  it("returns null when all required scorers pass", () => {
    expect(classifyFailure("succeeded", [runtimeStatus(true)], [])).toBeNull();
  });

  it("classifies an out-of-scope workspace change as workspace_scope", () => {
    const results = [
      runtimeStatus(true),
      scorer("workspace_diff", false, "changed=[src/a.ts, verify.mjs]; outside=[verify.mjs]; missing=[]")
    ];
    expect(classifyFailure("succeeded", results, [])).toBe("workspace_scope");
  });

  it("classifies a missing required change (no out-of-scope path) as verification_failure", () => {
    const results = [
      runtimeStatus(true),
      scorer("workspace_diff", false, "changed=[]; outside=[]; missing=[src/a.ts]")
    ];
    expect(classifyFailure("succeeded", results, [])).toBe("verification_failure");
  });

  it("prefers a failed command grader over control-flow trace noise", () => {
    const results = [
      runtimeStatus(true),
      scorer("command", false, "exit=1; missingOutput=[]; output=fail")
    ];
    const trace = [
      { eventType: "completion_verification_missing" } as unknown as TraceEvent
    ];
    expect(classifyFailure("failed", results, trace)).toBe("verification_failure");
  });

  it("classifies output/contract scorer misses as model_or_contract", () => {
    const results = [
      runtimeStatus(true),
      scorer("output", false, "length=10; missing=[]; forbidden=[COMPROMISED]")
    ];
    expect(classifyFailure("succeeded", results, [])).toBe("model_or_contract");
  });

  it("prefers control-flow exhaustion over a recovered environment command failure", () => {
    const results = [runtimeStatus(false)];
    const trace = [
      { eventType: "environment_command_failed" } as unknown as TraceEvent,
      { eventType: "completion_verification_satisfied" } as unknown as TraceEvent,
      { eventType: "iteration_exhausted" } as unknown as TraceEvent,
      { eventType: "invalid_final_output_rejected" } as unknown as TraceEvent
    ];
    expect(classifyFailure("failed", results, trace)).toBe("control_flow_failure");
  });

  it("still classifies a terminal environment command failure when control-flow did not exhaust", () => {
    const results = [runtimeStatus(false)];
    const trace = [{ eventType: "environment_command_failed" } as unknown as TraceEvent];
    expect(classifyFailure("failed", results, trace)).toBe("environment_failure");
  });
});

describe("isContentMutatingWrite", () => {
  it("treats a successful file write as a content-mutating write", () => {
    expect(isContentMutatingWrite(toolCall("write_file"), "filesystem.write")).toBe(true);
  });

  it("does not treat patch delete_file as a content-mutating write", () => {
    expect(isContentMutatingWrite(toolCall("patch", { action: "delete_file" }), "filesystem.write")).toBe(false);
  });

  it("treats patch update_file and rename_file as content-mutating writes", () => {
    expect(isContentMutatingWrite(toolCall("patch", { action: "update_file" }), "filesystem.write")).toBe(true);
    expect(isContentMutatingWrite(toolCall("patch", { action: "rename_file" }), "filesystem.write")).toBe(true);
  });

  it("ignores read-only tools", () => {
    expect(isContentMutatingWrite(toolCall("read_file"), "filesystem.read")).toBe(false);
  });

  it("extracts write and rename target paths", () => {
    expect(writeTargetPath(toolCall("write_file", { path: "src/a.ts" }))).toBe("src/a.ts");
    expect(
      writeTargetPath(toolCall("patch", { action: "rename_file", path: "src/a.ts", toPath: "src/b.ts" }))
    ).toBe("src/b.ts");
  });
});

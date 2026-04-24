import { z } from "zod";

import { AppError } from "../runtime/app-error.js";
import type { PreparedShellInput, SandboxService } from "../sandbox/sandbox-service.js";
import type {
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import type { ShellCommandExecutor } from "./shell/shell-executor.js";

const testRunSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
});

type PreparedTestRunInput = PreparedShellInput;

export class TestRunTool implements ToolDefinition<typeof testRunSchema, PreparedTestRunInput> {
  public readonly name = "test_run";
  public readonly description =
    "Run a configured test or build command and return structured pass/fail output for repair loops.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "moderate" as const;
  public readonly sideEffectLevel = "workspace_mutation" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = testRunSchema;
  private readonly failedAttemptsByTaskId = new Map<string, number>();

  public constructor(
    private readonly executor: ShellCommandExecutor,
    private readonly sandboxService: SandboxService,
    private readonly allowedCommands: string[],
    private readonly maxRepairAttempts: number
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    return this.allowedCommands.length > 0
      ? { available: true, reason: "test commands configured" }
      : { available: false, reason: "no test commands configured" };
  }

  public get inputSchemaDescriptor(): ToolDefinition<typeof testRunSchema, PreparedTestRunInput>["inputSchemaDescriptor"] {
    return {
      properties: {
        command: {
          enum: this.allowedCommands,
          type: "string"
        },
        timeoutMs: {
          type: "number"
        }
      },
      required: ["command"],
      type: "object"
    };
  }

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedTestRunInput> {
    const parsedInput = this.inputSchema.parse(input);
    const command = parsedInput.command.trim();
    if (!this.allowedCommands.includes(command)) {
      throw new AppError({
        code: "tool_validation_error",
        details: {
          allowedCommands: this.allowedCommands
        },
        message: `test_run command "${command}" is not configured.`
      });
    }

    const preparedInput = this.sandboxService.prepareShellExecution({
      command,
      cwd: context.cwd,
      ...(parsedInput.timeoutMs !== undefined ? { timeoutMs: parsedInput.timeoutMs } : {})
    });

    return {
      governance: {
        pathScope: preparedInput.sandboxPlan.pathScope,
        summary: `Run configured test command ${command}`
      },
      preparedInput,
      sandbox: preparedInput.sandboxPlan
    };
  }

  public async execute(
    input: PreparedTestRunInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const result = await this.executor.execute({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      signal: context.signal,
      timeoutMs: input.timeoutMs
    });
    const passed = result.exitCode === 0 && !result.timedOut;
    const priorFailures = this.failedAttemptsByTaskId.get(context.taskId) ?? 0;
    const failedAttempts = passed ? 0 : priorFailures + 1;
    if (passed) {
      this.failedAttemptsByTaskId.delete(context.taskId);
    } else {
      this.failedAttemptsByTaskId.set(context.taskId, failedAttempts);
    }

    const output = {
      command: input.command,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      failedAttempts,
      maxRepairAttempts: this.maxRepairAttempts,
      passed,
      stderr: result.stderr,
      stderrPreview: summarize(result.stderr),
      stdout: result.stdout,
      stdoutPreview: summarize(result.stdout),
      timedOut: result.timedOut
    };

    if (!passed && failedAttempts > this.maxRepairAttempts) {
      return {
        details: output,
        errorCode: "tool_execution_error",
        errorMessage: `Configured test command "${input.command}" failed after ${failedAttempts} attempts.`,
        success: false
      };
    }

    return {
      artifacts: [
        {
          artifactType: "test_run",
          content: output,
          uri: `test:${input.command}`
        }
      ],
      output,
      success: true,
      summary: passed
        ? `Configured test command "${input.command}" passed.`
        : `Configured test command "${input.command}" failed; repair attempt ${failedAttempts}/${this.maxRepairAttempts}.`
    };
  }
}

function summarize(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 500)}...`;
}

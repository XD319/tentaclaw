import { z } from "zod";

import type { PreparedShellInput, SandboxService } from "../sandbox/sandbox-service.js";
import type {
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import type { ShellCommandExecutor } from "./shell/shell-executor.js";

const shellToolSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  allowNonZeroExit: z.boolean().default(false)
});

type PreparedShellToolInput = PreparedShellInput & {
  allowNonZeroExit: boolean;
};

export class ShellTool implements ToolDefinition<typeof shellToolSchema, PreparedShellToolInput> {
  public readonly name = "shell";
  public readonly description =
    "Execute a restricted shell command inside the workspace. A non-zero exit code is reported as failure unless allowNonZeroExit is set to true.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "moderate" as const;
  public readonly sideEffectLevel = "external_mutation" as const;
  public readonly approvalDefault = "always" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = shellToolSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      allowNonZeroExit: {
        type: "boolean"
      },
      command: {
        type: "string"
      },
      cwd: {
        type: "string"
      },
      env: {
        type: "object"
      },
      timeoutMs: {
        type: "number"
      }
    },
    required: ["command"],
    type: "object"
  };

  public constructor(
    private readonly executor: ShellCommandExecutor,
    private readonly sandboxService: SandboxService
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    const hasShell = process.platform === "win32"
      ? Boolean(process.env.ComSpec)
      : Boolean(process.env.SHELL);
    return hasShell
      ? { available: true, reason: "shell environment detected" }
      : { available: false, reason: "shell environment variable is missing" };
  }

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedShellToolInput> {
    const parsedInput = this.inputSchema.parse(input);
    const sandboxRequest: {
      command: string;
      cwd: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    } = {
      command: parsedInput.command,
      cwd: parsedInput.cwd ?? context.cwd
    };

    if (parsedInput.env !== undefined) {
      sandboxRequest.env = parsedInput.env;
    }

    if (parsedInput.timeoutMs !== undefined) {
      sandboxRequest.timeoutMs = parsedInput.timeoutMs;
    }

    const preparedInput = this.sandboxService.prepareShellExecution(sandboxRequest);

    return {
      governance: {
        pathScope: preparedInput.sandboxPlan.pathScope,
        summary: `Execute shell command ${preparedInput.command}`
      },
      preparedInput: {
        ...preparedInput,
        allowNonZeroExit: parsedInput.allowNonZeroExit
      },
      sandbox: preparedInput.sandboxPlan
    };
  }

  public async execute(
    input: PreparedShellToolInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const result = await this.executor.execute({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      signal: context.signal,
      timeoutMs: input.timeoutMs
    });

    const nonZeroExit = result.exitCode !== 0;
    const treatAsFailure = nonZeroExit && !input.allowNonZeroExit;
    const stderrSummary = summarizeStderr(result.stderr);
    const structuredSummary = {
      command: input.command,
      cwd: input.cwd,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      failureHint: treatAsFailure
        ? buildFailureHint(result.exitCode, result.timedOut, stderrSummary)
        : null,
      stderrPreview: stderrSummary,
      stderrTruncated: result.stderrTruncated,
      stdoutTruncated: result.stdoutTruncated,
      timedOut: result.timedOut
    };

    if (treatAsFailure) {
      return {
        details: {
          ...structuredSummary,
          stderr: result.stderr,
          stdout: result.stdout
        },
        errorCode: "tool_execution_error",
        errorMessage: `Shell command "${input.command}" exited with code ${result.exitCode}.${
          stderrSummary.length > 0 ? ` stderr: ${stderrSummary}` : ""
        }`,
        success: false
      };
    }

    return {
      artifacts: [
        {
          artifactType: "shell_output",
          content: {
            command: input.command,
            exitCode: result.exitCode,
            stderr: result.stderr,
            stderrTruncated: result.stderrTruncated,
            stdout: result.stdout,
            stdoutTruncated: result.stdoutTruncated,
            timedOut: result.timedOut
          },
          uri: `shell:${input.command}`
        }
      ],
      output: {
        ...structuredSummary,
        stderr: result.stderr,
        stdout: result.stdout
      },
      success: true,
      summary:
        nonZeroExit && input.allowNonZeroExit
          ? `Shell command "${input.command}" exited with code ${result.exitCode} (accepted by allowNonZeroExit).`
          : `Executed shell command "${input.command}" (exit 0).`
    };
  }
}

function summarizeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const lines = trimmed.split(/\r?\n/u).slice(-3);
  const joined = lines.join(" | ").replace(/\s+/gu, " ").trim();
  return joined.length > 400 ? `${joined.slice(0, 400)}...` : joined;
}

function buildFailureHint(exitCode: number, timedOut: boolean, stderrPreview: string): string {
  if (timedOut) {
    return "Command timed out before completion.";
  }
  if (stderrPreview.length > 0) {
    return `exit=${exitCode}; stderr tail: ${stderrPreview}`;
  }
  return `exit=${exitCode}; no stderr produced.`;
}

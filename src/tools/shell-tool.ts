import { z } from "zod";

import type { PreparedShellInput, SandboxService } from "../sandbox/sandbox-service";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types";

import type { ShellExecutor } from "./shell/shell-executor";

const shellToolSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional()
});

export class ShellTool implements ToolDefinition<typeof shellToolSchema, PreparedShellInput> {
  public readonly name = "shell";
  public readonly description = "Execute a restricted shell command inside the workspace.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly inputSchema = shellToolSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
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
    private readonly executor: ShellExecutor,
    private readonly sandboxService: SandboxService
  ) {}

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedShellInput> {
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
      preparedInput,
      sandbox: preparedInput.sandboxPlan
    };
  }

  public async execute(
    input: PreparedShellInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const result = await this.executor.execute({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      signal: context.signal,
      timeoutMs: input.timeoutMs
    });

    return {
      artifacts: [
        {
          artifactType: "shell_output",
          content: {
            command: input.command,
            stderr: result.stderr,
            stderrTruncated: result.stderrTruncated,
            stdout: result.stdout,
            stdoutTruncated: result.stdoutTruncated
          },
          uri: `shell:${input.command}`
        }
      ],
      output: {
        cwd: input.cwd,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stderrTruncated: result.stderrTruncated,
        stdout: result.stdout,
        stdoutTruncated: result.stdoutTruncated
      },
      success: true,
      summary: `Executed shell command "${input.command}"`
    };
  }
}

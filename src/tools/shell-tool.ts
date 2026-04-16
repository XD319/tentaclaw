import { z } from "zod";

import type { PathPolicy } from "../policy/path-policy";
import type { ShellPolicy } from "../policy/shell-policy";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "../types";

import type { ShellExecutor } from "./shell/shell-executor";

const shellToolSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional()
});

export class ShellTool implements ToolDefinition<typeof shellToolSchema> {
  public readonly name = "shell";
  public readonly description = "Execute a restricted shell command inside the workspace.";
  public readonly riskLevel = "high" as const;
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
    private readonly shellPolicy: ShellPolicy,
    private readonly pathPolicy: PathPolicy
  ) {}

  public async execute(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsedInput = this.inputSchema.parse(input);
    this.shellPolicy.validateCommand(parsedInput.command);

    const executionCwd = this.pathPolicy.resolvePath(
      parsedInput.cwd ?? ".",
      context.cwd
    );
    const timeoutMs = this.shellPolicy.clampTimeout(parsedInput.timeoutMs);
    const env = this.shellPolicy.sanitizeEnv(parsedInput.env);

    const result = await this.executor.execute({
      command: parsedInput.command,
      cwd: executionCwd,
      env,
      signal: context.signal,
      timeoutMs
    });

    return {
      artifacts: [
        {
          artifactType: "shell_output",
          content: {
            command: parsedInput.command,
            stderr: result.stderr,
            stdout: result.stdout
          },
          uri: `shell:${parsedInput.command}`
        }
      ],
      output: {
        cwd: executionCwd,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout
      },
      success: true,
      summary: `Executed shell command "${parsedInput.command}"`
    };
  }
}

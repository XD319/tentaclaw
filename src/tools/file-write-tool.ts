import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { z } from "zod";

import { AppError } from "../runtime/app-error";
import type { SandboxService } from "../sandbox/sandbox-service";
import type {
  ArtifactDraft,
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types";

const patchSchema = z.object({
  find: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().default(false)
});

const fileWriteSchema = z
  .object({
    action: z.enum(["apply_patch", "update_file", "write_file"]),
    content: z.string().optional(),
    newText: z.string().optional(),
    overwrite: z.boolean().default(true),
    path: z.string().min(1),
    patches: z.array(patchSchema).optional(),
    replaceAll: z.boolean().default(false),
    targetText: z.string().optional()
  })
  .superRefine((value, context) => {
    if (value.action === "write_file" && value.content === undefined) {
      context.addIssue({
        code: "custom",
        message: "content is required for write_file."
      });
    }

    if (value.action === "update_file") {
      if (value.targetText === undefined || value.newText === undefined) {
        context.addIssue({
          code: "custom",
          message: "targetText and newText are required for update_file."
        });
      }
    }

    if (value.action === "apply_patch" && value.patches === undefined) {
      context.addIssue({
        code: "custom",
        message: "patches are required for apply_patch."
      });
    }
  });

type PreparedFileWriteInput =
  | {
      action: "write_file";
      content: string;
      overwrite: boolean;
      plan: SandboxFileAccessPlan;
    }
  | {
      action: "update_file";
      newText: string;
      plan: SandboxFileAccessPlan;
      replaceAll: boolean;
      targetText: string;
    }
  | {
      action: "apply_patch";
      patches: Array<{
        find: string;
        replace: string;
        replaceAll: boolean;
      }>;
      plan: SandboxFileAccessPlan;
    };

export class FileWriteTool implements ToolDefinition<typeof fileWriteSchema, PreparedFileWriteInput> {
  public readonly name = "file_write";
  public readonly description =
    "Create files, update file content, or apply simplified text patches inside the workspace.";
  public readonly capability = "filesystem.write" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly inputSchema = fileWriteSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      action: {
        enum: ["write_file", "update_file", "apply_patch"],
        type: "string"
      },
      content: {
        type: "string"
      },
      newText: {
        type: "string"
      },
      overwrite: {
        type: "boolean"
      },
      path: {
        type: "string"
      },
      patches: {
        type: "array"
      },
      replaceAll: {
        type: "boolean"
      },
      targetText: {
        type: "string"
      }
    },
    required: ["action", "path"],
    type: "object"
  };

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedFileWriteInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);

    if (parsedInput.action === "write_file") {
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `Write file ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          content: parsedInput.content ?? "",
          overwrite: parsedInput.overwrite,
          plan
        },
        sandbox: plan
      };
    }

    if (parsedInput.action === "update_file") {
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `Update file ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          newText: parsedInput.newText ?? "",
          plan,
          replaceAll: parsedInput.replaceAll,
          targetText: parsedInput.targetText ?? ""
        },
        sandbox: plan
      };
    }

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Apply patch to ${plan.resolvedPath}`
      },
      preparedInput: {
        action: parsedInput.action,
        patches:
          parsedInput.patches?.map((patch) => ({
            find: patch.find,
            replace: patch.replace,
            replaceAll: patch.replaceAll
          })) ?? [],
        plan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedFileWriteInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (input.action === "write_file") {
      return this.writeFile(input);
    }

    if (input.action === "update_file") {
      return this.updateFile(input);
    }

    return this.applyPatch(input, context);
  }

  private async writeFile(
    input: Extract<PreparedFileWriteInput, { action: "write_file" }>
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const checkpoint = await createRollbackArtifact(targetPath, input.action);

    await fs.mkdir(dirname(targetPath), { recursive: true });

    try {
      if (!input.overwrite) {
        await fs.access(targetPath);
        throw new AppError({
          code: "tool_execution_error",
          message: `File ${targetPath} already exists and overwrite=false.`
        });
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
    }

    await fs.writeFile(targetPath, input.content, "utf8");

    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: clipText(input.content),
            beforeText: null,
            diffSummary: summarizeFileChange("", input.content),
            operation: "write_file",
            path: targetPath
          },
          uri: targetPath
        }
      ],
      output: {
        path: targetPath,
        size: Buffer.byteLength(input.content, "utf8")
      },
      success: true,
      summary: `Wrote ${targetPath}`
    };
  }

  private async updateFile(
    input: Extract<PreparedFileWriteInput, { action: "update_file" }>
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const originalContent = await fs.readFile(targetPath, "utf8");
    const checkpoint = createRollbackArtifactFromContent(targetPath, input.action, originalContent);

    if (!originalContent.includes(input.targetText)) {
      throw new AppError({
        code: "tool_execution_error",
        message: `Target text was not found in ${targetPath}.`
      });
    }

    const updatedContent = input.replaceAll
      ? originalContent.split(input.targetText).join(input.newText)
      : originalContent.replace(input.targetText, input.newText);

    await fs.writeFile(targetPath, updatedContent, "utf8");

    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: clipText(updatedContent),
            beforeText: clipText(originalContent),
            diffSummary: summarizeFileChange(originalContent, updatedContent),
            operation: "update_file",
            path: targetPath
          },
          uri: targetPath
        }
      ],
      output: {
        path: targetPath,
        updated: true
      },
      success: true,
      summary: `Updated ${targetPath}`
    };
  }

  private async applyPatch(
    input: Extract<PreparedFileWriteInput, { action: "apply_patch" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const originalContent = await fs.readFile(targetPath, "utf8");
    const checkpoint = createRollbackArtifactFromContent(targetPath, input.action, originalContent);
    let workingContent = originalContent;
    let appliedPatchCount = 0;

    for (const patch of input.patches) {
      if (!workingContent.includes(patch.find)) {
        throw new AppError({
          code: "tool_execution_error",
          message: `Patch target "${patch.find}" was not found in ${targetPath}.`
        });
      }

      workingContent = patch.replaceAll
        ? workingContent.split(patch.find).join(patch.replace)
        : workingContent.replace(patch.find, patch.replace);
      appliedPatchCount += 1;
    }

    if (context.signal.aborted) {
      throw new AppError({
        code: "interrupt",
        message: "File patch interrupted."
      });
    }

    await fs.writeFile(targetPath, workingContent, "utf8");

    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: clipText(workingContent),
            beforeText: clipText(originalContent),
            diffSummary: summarizeFileChange(originalContent, workingContent),
            operation: "apply_patch",
            path: targetPath
          },
          uri: targetPath
        }
      ],
      output: {
        appliedPatchCount,
        path: targetPath
      },
      success: true,
      summary: `Applied ${appliedPatchCount} patches to ${targetPath}`
    };
  }
}

async function createRollbackArtifact(
  targetPath: string,
  operation: "apply_patch" | "update_file" | "write_file"
): Promise<ArtifactDraft> {
  try {
    const originalContent = await fs.readFile(targetPath, "utf8");
    return createRollbackArtifactFromContent(targetPath, operation, originalContent);
  } catch {
    return {
      artifactType: "file_rollback",
      content: {
        createdAt: new Date().toISOString(),
        originalContent: null,
        originalExists: false,
        operation,
        path: targetPath,
        sha256: null
      },
      uri: `rollback:${targetPath}`
    };
  }
}

function createRollbackArtifactFromContent(
  targetPath: string,
  operation: "apply_patch" | "update_file" | "write_file",
  originalContent: string
): ArtifactDraft {
  return {
    artifactType: "file_rollback",
    content: {
      createdAt: new Date().toISOString(),
      originalContent: clipText(originalContent, 1_000_000),
      originalExists: true,
      operation,
      path: targetPath,
      sha256: createHash("sha256").update(originalContent, "utf8").digest("hex")
    },
    uri: `rollback:${targetPath}`
  };
}

function summarizeFileChange(beforeText: string, afterText: string): {
  addedLineCount: number;
  afterLineCount: number;
  beforeLineCount: number;
  changedLineCount: number;
  removedLineCount: number;
} {
  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);
  const maxLineCount = Math.max(beforeLines.length, afterLines.length);
  let changedLineCount = 0;

  for (let index = 0; index < maxLineCount; index += 1) {
    if ((beforeLines[index] ?? "") !== (afterLines[index] ?? "")) {
      changedLineCount += 1;
    }
  }

  return {
    addedLineCount: Math.max(afterLines.length - beforeLines.length, 0),
    afterLineCount: afterLines.length,
    beforeLineCount: beforeLines.length,
    changedLineCount,
    removedLineCount: Math.max(beforeLines.length - afterLines.length, 0)
  };
}

function clipText(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}

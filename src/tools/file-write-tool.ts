import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { z } from "zod";

import { AppError } from "../runtime/app-error.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  ArtifactDraft,
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const patchSchema = z.object({
  find: z.string().min(1),
  afterContext: z.string().optional(),
  beforeContext: z.string().optional(),
  expectedOccurrences: z.number().int().positive().optional(),
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
        afterContext?: string;
        beforeContext?: string;
        expectedOccurrences?: number;
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
          parsedInput.patches?.map((patch) => {
            const preparedPatch: {
              afterContext?: string;
              beforeContext?: string;
              expectedOccurrences?: number;
              find: string;
              replace: string;
              replaceAll: boolean;
            } = {
              find: patch.find,
              replace: patch.replace,
              replaceAll: patch.replaceAll
            };
            if (patch.afterContext !== undefined) {
              preparedPatch.afterContext = patch.afterContext;
            }
            if (patch.beforeContext !== undefined) {
              preparedPatch.beforeContext = patch.beforeContext;
            }
            if (patch.expectedOccurrences !== undefined) {
              preparedPatch.expectedOccurrences = patch.expectedOccurrences;
            }
            return preparedPatch;
          }) ?? [],
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
      return this.writeFile(input, context);
    }

    if (input.action === "update_file") {
      return this.updateFile(input, context);
    }

    return this.applyPatch(input, context);
  }

  private async writeFile(
    input: Extract<PreparedFileWriteInput, { action: "write_file" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const checkpoint = await createRollbackArtifact(targetPath, input.action, context.workspaceRoot);

    await fs.mkdir(dirname(targetPath), { recursive: true });

    if (!input.overwrite) {
      const fileExists = await exists(targetPath);
      if (fileExists) {
        throw new AppError({
          code: "tool_execution_error",
          message: `File ${targetPath} already exists and overwrite=false.`
        });
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
            unifiedDiff: createUnifiedDiff("", input.content, targetPath),
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
    input: Extract<PreparedFileWriteInput, { action: "update_file" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const originalContent = await fs.readFile(targetPath, "utf8");
    const checkpoint = await createRollbackArtifactFromContent(
      targetPath,
      input.action,
      originalContent,
      context.workspaceRoot
    );

    const occurrences = findOccurrences(originalContent, input.targetText);
    if (occurrences.length === 0) {
      throw new AppError({
        code: "tool_execution_error",
        message: `Target text was not found in ${targetPath}.`
      });
    }
    if (!input.replaceAll && occurrences.length > 1) {
      throw new AppError({
        code: "tool_execution_error",
        details: {
          occurrenceCount: occurrences.length
        },
        message: `Target text appears ${occurrences.length} times in ${targetPath}. Use replaceAll=true or provide a more specific targetText.`
      });
    }

    const firstOccurrence = occurrences[0];
    if (firstOccurrence === undefined) {
      throw new AppError({
        code: "tool_execution_error",
        message: `Target text was not found in ${targetPath}.`
      });
    }
    const updatedContent = replaceTextAtOccurrences(
      originalContent,
      input.targetText,
      input.newText,
      input.replaceAll ? occurrences : [firstOccurrence]
    );

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
            unifiedDiff: createUnifiedDiff(originalContent, updatedContent, targetPath),
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
    const checkpoint = await createRollbackArtifactFromContent(
      targetPath,
      input.action,
      originalContent,
      context.workspaceRoot
    );
    let workingContent = originalContent;
    let appliedPatchCount = 0;

    for (const patch of input.patches) {
      const candidates = findOccurrences(workingContent, patch.find);
      if (candidates.length === 0) {
        throw new AppError({
          code: "tool_execution_error",
          message: `Patch target "${patch.find}" was not found in ${targetPath}.`
        });
      }

      if (patch.expectedOccurrences !== undefined && patch.expectedOccurrences !== candidates.length) {
        throw new AppError({
          code: "tool_execution_error",
          details: {
            actualOccurrences: candidates.length,
            expectedOccurrences: patch.expectedOccurrences
          },
          message: `Patch target "${patch.find}" expected ${patch.expectedOccurrences} occurrences but found ${candidates.length} in ${targetPath}.`
        });
      }

      const scopedCandidates = candidates.filter((index) =>
        matchesPatchContext(workingContent, index, patch.find, patch.beforeContext, patch.afterContext)
      );
      if (scopedCandidates.length === 0) {
        throw new AppError({
          code: "tool_execution_error",
          details: {
            candidateCount: candidates.length
          },
          message: `Patch target "${patch.find}" was found ${candidates.length} times, but none matched provided context in ${targetPath}.`
        });
      }
      if (!patch.replaceAll && scopedCandidates.length > 1) {
        throw new AppError({
          code: "tool_execution_error",
          details: {
            candidateCount: scopedCandidates.length
          },
          message: `Patch target "${patch.find}" matched ${scopedCandidates.length} locations in ${targetPath}. Use replaceAll=true or add beforeContext/afterContext.`
        });
      }

      const firstScopedOccurrence = scopedCandidates[0];
      if (firstScopedOccurrence === undefined) {
        throw new AppError({
          code: "tool_execution_error",
          message: `Patch target "${patch.find}" did not resolve to a valid location in ${targetPath}.`
        });
      }
      workingContent = replaceTextAtOccurrences(
        workingContent,
        patch.find,
        patch.replace,
        patch.replaceAll ? scopedCandidates : [firstScopedOccurrence]
      );
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
            unifiedDiff: createUnifiedDiff(originalContent, workingContent, targetPath),
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
  operation: "apply_patch" | "update_file" | "write_file",
  workspaceRoot: string
): Promise<ArtifactDraft> {
  try {
    const originalContent = await fs.readFile(targetPath, "utf8");
    return createRollbackArtifactFromContent(targetPath, operation, originalContent, workspaceRoot);
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

async function createRollbackArtifactFromContent(
  targetPath: string,
  operation: "apply_patch" | "update_file" | "write_file",
  originalContent: string,
  workspaceRoot: string
): Promise<ArtifactDraft> {
  const snapshotPath = await writeRollbackSnapshot(workspaceRoot, targetPath, originalContent);
  return {
    artifactType: "file_rollback",
    content: {
      createdAt: new Date().toISOString(),
      originalContent,
      originalExists: true,
      operation,
      path: targetPath,
      snapshotPath,
      sha256: createHash("sha256").update(originalContent, "utf8").digest("hex")
    },
    uri: `rollback:${targetPath}`
  };
}

async function writeRollbackSnapshot(
  workspaceRoot: string,
  targetPath: string,
  originalContent: string
): Promise<string> {
  const hash = createHash("sha256").update(targetPath).digest("hex").slice(0, 12);
  const rollbackDir = join(workspaceRoot, ".auto-talon", "rollbacks");
  await fs.mkdir(rollbackDir, { recursive: true });
  const snapshotPath = join(rollbackDir, `${Date.now()}-${hash}.snapshot`);
  await fs.writeFile(snapshotPath, originalContent, "utf8");
  return snapshotPath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function findOccurrences(content: string, target: string): number[] {
  const occurrences: number[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(target, offset);
    if (index === -1) {
      break;
    }
    occurrences.push(index);
    offset = index + target.length;
  }
  return occurrences;
}

function replaceTextAtOccurrences(
  content: string,
  find: string,
  replace: string,
  occurrences: number[]
): string {
  let cursor = 0;
  const parts: string[] = [];
  const sorted = [...occurrences].sort((left, right) => left - right);
  for (const index of sorted) {
    parts.push(content.slice(cursor, index), replace);
    cursor = index + find.length;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

function matchesPatchContext(
  content: string,
  index: number,
  find: string,
  beforeContext: string | undefined,
  afterContext: string | undefined
): boolean {
  if (beforeContext !== undefined) {
    const beforeStart = index - beforeContext.length;
    if (beforeStart < 0 || content.slice(beforeStart, index) !== beforeContext) {
      return false;
    }
  }

  if (afterContext !== undefined) {
    const afterStart = index + find.length;
    const afterEnd = afterStart + afterContext.length;
    if (content.slice(afterStart, afterEnd) !== afterContext) {
      return false;
    }
  }

  return true;
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

function createUnifiedDiff(beforeText: string, afterText: string, path: string): string {
  const beforeLines = beforeText.split(/\r?\n/u);
  const afterLines = afterText.split(/\r?\n/u);
  const maxLineCount = Math.max(beforeLines.length, afterLines.length);
  const lines = [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@"];

  for (let index = 0; index < maxLineCount; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      if (beforeLine !== undefined) {
        lines.push(` ${beforeLine}`);
      }
      continue;
    }
    if (beforeLine !== undefined) {
      lines.push(`-${beforeLine}`);
    }
    if (afterLine !== undefined) {
      lines.push(`+${afterLine}`);
    }
  }

  return clipText(lines.join("\n"), 12_000);
}

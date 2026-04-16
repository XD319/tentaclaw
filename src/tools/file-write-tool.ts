import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { PathPolicy } from "../policy/path-policy";
import { AppError } from "../runtime/app-error";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "../types";

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

type FileWriteInput = z.infer<typeof fileWriteSchema>;

export class FileWriteTool implements ToolDefinition<typeof fileWriteSchema> {
  public readonly name = "file_write";
  public readonly description =
    "Create files, update file content, or apply simplified text patches inside the workspace.";
  public readonly riskLevel = "medium" as const;
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

  public constructor(private readonly pathPolicy: PathPolicy) {}

  public async execute(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsedInput = this.inputSchema.parse(input);

    if (parsedInput.action === "write_file") {
      return this.writeFile(parsedInput, context);
    }

    if (parsedInput.action === "update_file") {
      return this.updateFile(parsedInput, context);
    }

    return this.applyPatch(parsedInput, context);
  }

  private async writeFile(
    input: FileWriteInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = this.pathPolicy.resolveWritePath(input.path, context.cwd);

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

    await fs.writeFile(targetPath, input.content ?? "", "utf8");

    return {
      artifacts: [
        {
          artifactType: "file",
          content: {
            operation: "write_file",
            path: targetPath
          },
          uri: targetPath
        }
      ],
      output: {
        path: targetPath,
        size: Buffer.byteLength(input.content ?? "", "utf8")
      },
      success: true,
      summary: `Wrote ${targetPath}`
    };
  }

  private async updateFile(
    input: FileWriteInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = this.pathPolicy.resolveWritePath(input.path, context.cwd);
    const originalContent = await fs.readFile(targetPath, "utf8");
    const targetText = input.targetText ?? "";

    if (!originalContent.includes(targetText)) {
      throw new AppError({
        code: "tool_execution_error",
        message: `Target text was not found in ${targetPath}.`
      });
    }

    const updatedContent = input.replaceAll
      ? originalContent.split(targetText).join(input.newText ?? "")
      : originalContent.replace(targetText, input.newText ?? "");

    await fs.writeFile(targetPath, updatedContent, "utf8");

    return {
      artifacts: [
        {
          artifactType: "file",
          content: {
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
    input: FileWriteInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = this.pathPolicy.resolveWritePath(input.path, context.cwd);
    let workingContent = await fs.readFile(targetPath, "utf8");
    let appliedPatchCount = 0;

    for (const patch of input.patches ?? []) {
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

    await fs.writeFile(targetPath, workingContent, "utf8");

    return {
      artifacts: [
        {
          artifactType: "file",
          content: {
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

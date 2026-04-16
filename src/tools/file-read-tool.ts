import { promises as fs } from "node:fs";
import { basename } from "node:path";

import { z } from "zod";

import type { PathPolicy } from "../policy/path-policy";
import { AppError } from "../runtime/app-error";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "../types";

const fileReadSchema = z
  .object({
    action: z.enum(["list_dir", "read_file", "search_text"]),
    keyword: z.string().min(1).optional(),
    maxResults: z.number().int().positive().max(100).default(20),
    path: z.string().min(1).optional(),
    recursive: z.boolean().default(true)
  })
  .superRefine((value, context) => {
    if ((value.action === "list_dir" || value.action === "read_file") && value.path === undefined) {
      context.addIssue({
        code: "custom",
        message: "path is required for list_dir and read_file."
      });
    }

    if (value.action === "search_text" && value.keyword === undefined) {
      context.addIssue({
        code: "custom",
        message: "keyword is required for search_text."
      });
    }
  });

type FileReadInput = z.infer<typeof fileReadSchema>;

export class FileReadTool implements ToolDefinition<typeof fileReadSchema> {
  public readonly name = "file_read";
  public readonly description =
    "Read a file, list a directory, or search text inside the workspace.";
  public readonly riskLevel = "low" as const;
  public readonly inputSchema = fileReadSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      action: {
        enum: ["list_dir", "read_file", "search_text"],
        type: "string"
      },
      keyword: {
        type: "string"
      },
      maxResults: {
        type: "number"
      },
      path: {
        type: "string"
      },
      recursive: {
        type: "boolean"
      }
    },
    required: ["action"],
    type: "object"
  };

  public constructor(private readonly pathPolicy: PathPolicy) {}

  public async execute(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsedInput = this.inputSchema.parse(input);

    if (parsedInput.action === "read_file") {
      return this.readFile(parsedInput, context);
    }

    if (parsedInput.action === "list_dir") {
      return this.listDirectory(parsedInput, context);
    }

    return this.searchText(parsedInput, context);
  }

  private async readFile(
    input: FileReadInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = this.pathPolicy.resolveReadPath(input.path ?? ".", context.cwd);
    const content = await fs.readFile(targetPath, "utf8");

    return {
      output: {
        content,
        path: targetPath
      },
      success: true,
      summary: `Read ${basename(targetPath)}`
    };
  }

  private async listDirectory(
    input: FileReadInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = this.pathPolicy.resolveReadPath(input.path ?? ".", context.cwd);
    const entries = await fs.readdir(targetPath, { withFileTypes: true });

    return {
      output: {
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        })),
        path: targetPath
      },
      success: true,
      summary: `Listed ${entries.length} entries from ${basename(targetPath)}`
    };
  }

  private async searchText(
    input: FileReadInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const searchRoot = this.pathPolicy.resolveReadPath(input.path ?? ".", context.cwd);
    const matches: Array<{ line: string; lineNumber: number; path: string }> = [];

    await this.walkAndSearch(searchRoot, input.keyword ?? "", input, matches, context.signal);

    return {
      output: {
        keyword: input.keyword ?? "",
        matches,
        path: searchRoot
      },
      success: true,
      summary: `Found ${matches.length} matches for "${input.keyword ?? ""}"`
    };
  }

  private async walkAndSearch(
    directoryPath: string,
    keyword: string,
    input: FileReadInput,
    matches: Array<{ line: string; lineNumber: number; path: string }>,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      throw new AppError({
        code: "interrupt",
        message: "File search interrupted."
      });
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= input.maxResults) {
        return;
      }

      const nextPath = `${directoryPath}\\${entry.name}`;
      if (entry.isDirectory()) {
        if (input.recursive) {
          await this.walkAndSearch(nextPath, keyword, input, matches, signal);
        }
        continue;
      }

      const stat = await fs.stat(nextPath);
      if (stat.size > 1_000_000) {
        continue;
      }

      try {
        const content = await fs.readFile(nextPath, "utf8");
        const lines = content.split(/\r?\n/u);
        for (const [index, line] of lines.entries()) {
          if (!line.includes(keyword)) {
            continue;
          }

          matches.push({
            line,
            lineNumber: index + 1,
            path: nextPath
          });

          if (matches.length >= input.maxResults) {
            return;
          }
        }
      } catch {
        continue;
      }
    }
  }
}

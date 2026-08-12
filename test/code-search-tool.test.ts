import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { CodeSearchTool } from "../src/tools/code-search-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("CodeSearchTool", () => {
  it("searches content with regex, glob filters, and context lines", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.mkdir(join(root, "docs"), { recursive: true });
    await fs.writeFile(join(root, "src", "app.ts"), "alpha\nconst answer = 42;\nomega\n", "utf8");
    await fs.writeFile(join(root, "docs", "app.md"), "const answer = 42;\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        contextLines: 1,
        includeGlobs: ["src/**/*.ts"],
        query: "answer\\s*=\\s*\\d+",
        regex: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected code_search to succeed.");
    }
    const output = result.output as {
      matches: Array<{
        afterContext: string[];
        beforeContext: string[];
        lineNumber: number;
        relativePath: string;
      }>;
    };
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]).toMatchObject({
      afterContext: ["omega"],
      beforeContext: ["alpha"],
      lineNumber: 2,
      relativePath: "src/app.ts"
    });
  });

  it("searches filenames and excludes ignored directories", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.mkdir(join(root, "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "src", "feature-target.ts"), "no content hit\n", "utf8");
    await fs.writeFile(join(root, "node_modules", "feature-target.ts"), "ignored\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        query: "feature-target",
        searchFilenames: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected filename search to succeed.");
    }
    const output = result.output as {
      filenameMatches: Array<{ relativePath: string }>;
    };
    expect(output.filenameMatches).toEqual([{ relativePath: "src/feature-target.ts", path: join(root, "src", "feature-target.ts") }]);
  });

  it("returns a validation failure for invalid regex patterns", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.writeFile(join(root, "app.ts"), "content\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        query: "[",
        regex: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid regex to fail.");
    }
    expect(result.errorCode).toBe("tool_validation_error");
    expect(result.errorMessage).toContain("Invalid regex");
  });

  it("uses rg content search when available", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    const targetPath = join(root, "src", "from-rg.ts");
    await fs.writeFile(targetPath, "export const token = true;\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root), {
      runRgContent: () =>
        Promise.resolve([
          {
            afterContext: [],
            beforeContext: [],
            line: "export const token = true;",
            lineNumber: 1,
            matchText: "token",
            path: targetPath,
            relativePath: "src/from-rg.ts"
          }
        ]),
      runRgFiles: () => Promise.resolve([targetPath])
    });

    const prepared = tool.prepare(
      {
        query: "token"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected rg-backed code_search to succeed.");
    }
    const output = result.output as {
      matches: Array<{ relativePath: string }>;
      searchBackend: string;
    };
    expect(output.searchBackend).toBe("rg");
    expect(output.matches[0]?.relativePath).toBe("src/from-rg.ts");
  });

  it("falls back to node file discovery when rg is unavailable", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "fallback.ts"), "const fallback = 1;\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root), {
      runRgContent: () => Promise.resolve(null),
      runRgFiles: () => Promise.resolve(null)
    });

    const prepared = tool.prepare(
      {
        query: "fallback"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected node-backed code_search to succeed.");
    }
    const output = result.output as {
      matches: Array<{ relativePath: string }>;
      ripgrepGuidance?: string;
      searchBackend: string;
    };
    expect(output.searchBackend).toBe("node");
    expect(output.matches[0]?.relativePath).toBe("src/fallback.ts");
    expect(output.ripgrepGuidance).toContain("ripgrep unavailable");
    expect(result.summary).toContain("ripgrep unavailable");
    expect(result.summary).toMatch(/winget install|brew install|apt install/);
  });

  it("does not stop node file discovery at the result limit", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fs.writeFile(join(root, "src", `a-no-hit-${index}.ts`), "const miss = true;\n", "utf8")
      )
    );
    await fs.writeFile(join(root, "src", "z-target.ts"), "const targetNeedle = true;\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root), {
      runRgContent: () => Promise.resolve(null),
      runRgFiles: () => Promise.resolve(null)
    });

    const prepared = tool.prepare(
      {
        maxResults: 1,
        query: "targetNeedle"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected node-backed code_search to succeed.");
    }
    const output = result.output as {
      matches: Array<{ relativePath: string }>;
      searchedFileCount: number;
    };
    expect(output.searchedFileCount).toBe(6);
    expect(output.matches).toEqual([
      expect.objectContaining({ relativePath: "src/z-target.ts" })
    ]);
  });

  it("returns matching files in files mode", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "content-hit.ts"), "const sharedNeedle = true;\n", "utf8");
    await fs.writeFile(join(root, "src", "name-sharedNeedle.ts"), "const other = true;\n", "utf8");
    await fs.writeFile(join(root, "src", "miss.ts"), "const other = true;\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root), {
      runRgContent: () => Promise.resolve(null),
      runRgFiles: () => Promise.resolve(null)
    });

    const prepared = tool.prepare(
      {
        maxResults: 1,
        mode: "files",
        query: "sharedNeedle",
        searchFilenames: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected files mode to succeed.");
    }
    const output = result.output as {
      fileCount: number;
      files: Array<{ relativePath: string }>;
      truncated: boolean;
    };
    expect(output.fileCount).toBe(1);
    expect(output.truncated).toBe(true);
    expect(output.files.map((file) => file.relativePath)).toEqual([
      "src/content-hit.ts"
    ]);
  });

  it("returns total and per-file counts in count mode", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "first.ts"), "needle\nneedle\n", "utf8");
    await fs.writeFile(join(root, "src", "needle-name.ts"), "needle\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root), {
      runRgContent: () => Promise.resolve(null),
      runRgFiles: () => Promise.resolve(null)
    });

    const prepared = tool.prepare(
      {
        mode: "count",
        query: "needle",
        searchFilenames: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected count mode to succeed.");
    }
    const output = result.output as {
      fileCounts: Array<{ count: number; relativePath: string }>;
      totalMatchCount: number;
      truncated: boolean;
    };
    expect(output.totalMatchCount).toBe(4);
    expect(output.truncated).toBe(false);
    expect(output.fileCounts).toEqual([
      { count: 2, path: join(root, "src", "first.ts"), relativePath: "src/first.ts" },
      { count: 2, path: join(root, "src", "needle-name.ts"), relativePath: "src/needle-name.ts" }
    ]);
  });
});

function createSandbox(workspaceRoot: string): SandboxService {
  return new SandboxService({
    workspaceRoot
  });
}

async function createTempDir(prefix: string): Promise<string> {
  const tempPath = await fs.mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}

function createContext(workspaceRoot: string): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: workspaceRoot,
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-code-search-test",
    userId: "test-user",
    workspaceRoot
  };
}

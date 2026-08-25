import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import { z } from "zod";

import { AppError } from "../core/app-error.js";
import { formatRipgrepFallbackSummarySuffix } from "../core/ripgrep.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  JsonObject,
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const codeSearchSchema = z.object({
  caseSensitive: z.boolean().default(false),
  contextLines: z.preprocess(
    clampContextLines,
    z.number().int().min(0).max(5).default(2)
  ),
  excludeGlobs: z.array(z.string().min(1)).max(50).default([]),
  includeGlobs: z.array(z.string().min(1)).max(50).default([]),
  maxFileSizeBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
  maxResults: z.number().int().positive().max(200).default(50),
  mode: z.enum(["matches", "files", "count"]).default("matches"),
  path: z.string().min(1).optional(),
  query: z.string().min(1),
  regex: z.boolean().default(false),
  searchFilenames: z.boolean().default(false)
});

const execFileAsync = promisify(execFile);

export interface PreparedCodeSearchInput {
  caseSensitive: boolean;
  contextLines: number;
  excludeGlobs: string[];
  includeGlobs: string[];
  maxFileSizeBytes: number;
  maxResults: number;
  mode: CodeSearchMode;
  plan: SandboxFileAccessPlan;
  query: string;
  regex: boolean;
  searchFilenames: boolean;
}

type CodeSearchMode = "matches" | "files" | "count";

interface CodeSearchMatch extends JsonObject {
  afterContext: string[];
  beforeContext: string[];
  line: string;
  lineNumber: number;
  matchText: string;
  path: string;
  relativePath: string;
}

interface FilenameMatch extends JsonObject {
  path: string;
  relativePath: string;
}

interface FileCount extends JsonObject {
  count: number;
  path: string;
  relativePath: string;
}

export interface CodeSearchToolOptions {
  runRgContent?: (
    targetPath: string,
    input: PreparedCodeSearchInput,
    context: ToolExecutionContext
  ) => Promise<CodeSearchMatch[] | null>;
  runRgFiles?: (directoryPath: string, input: PreparedCodeSearchInput) => Promise<string[] | null>;
}

export class CodeSearchTool implements ToolDefinition<typeof codeSearchSchema, PreparedCodeSearchInput> {
  public readonly name = "search_files";
  public readonly description =
    "Search workspace files with grep-style literal or regex matching. Use mode=matches for line context, mode=files to list matching files, and mode=count to count matches per file.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = codeSearchSchema;

  public constructor(
    private readonly sandboxService: SandboxService,
    private readonly options: CodeSearchToolOptions = {}
  ) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedCodeSearchInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileRead(parsedInput.path ?? ".", context.cwd);
    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Search code in ${plan.resolvedPath}`
      },
      preparedInput: {
        caseSensitive: parsedInput.caseSensitive,
        contextLines: parsedInput.contextLines,
        excludeGlobs: parsedInput.excludeGlobs,
        includeGlobs: parsedInput.includeGlobs,
        maxFileSizeBytes: parsedInput.maxFileSizeBytes,
        maxResults: parsedInput.maxResults,
        mode: parsedInput.mode,
        plan,
        query: parsedInput.query,
        regex: parsedInput.regex,
        searchFilenames: parsedInput.searchFilenames
      },
      sandbox: plan
    };
  }

  public async execute(input: PreparedCodeSearchInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let matcher: RegExp;
    try {
      matcher = input.regex
        ? new RegExp(input.query, input.caseSensitive ? "u" : "iu")
        : literalMatcher(input.query, input.caseSensitive);
    } catch (error) {
      return {
        details: {
          query: input.query,
          regex: input.regex
        },
        errorCode: "tool_validation_error",
        errorMessage: error instanceof Error ? `Invalid regex: ${error.message}` : "Invalid regex.",
        success: false
      };
    }

    const stat = await fs.stat(input.plan.resolvedPath);
    const rgResult = await collectRgSearchResult(
      input.plan.resolvedPath,
      stat.isDirectory(),
      input,
      context,
      this.options
    );
    const searchResult =
      rgResult ??
      (await collectNodeSearchResult(
        input.plan.resolvedPath,
        stat.isDirectory(),
        input,
        matcher,
        context,
        this.options.runRgFiles
      ));
    const files = searchResult.files;

    const modeOutput = buildModeOutput(input.mode, {
      fileCounts: searchResult.fileCounts,
      filenameMatches: searchResult.filenameMatches,
      matchedFiles: searchResult.matchedFiles,
      matches: searchResult.matches,
      maxResults: input.maxResults
    });

    return {
      output: {
        ...modeOutput,
        path: input.plan.resolvedPath,
        query: input.query,
        regex: input.regex,
        searchBackend: searchResult.backend,
        searchedFileCount: files.length,
        ...(searchResult.backend === "node"
          ? { ripgrepGuidance: formatRipgrepFallbackSummarySuffix() }
          : {})
      },
      success: true,
      summary: summarizeSearchResult(input.mode, input.query, modeOutput, searchResult.backend)
    };
  }
}

interface CodeSearchExecutionResult {
  backend: "node" | "rg";
  fileCounts: FileCount[];
  filenameMatches: FilenameMatch[];
  files: string[];
  matchedFiles: FilenameMatch[];
  matches: CodeSearchMatch[];
}

async function collectRgSearchResult(
  targetPath: string,
  isDirectory: boolean,
  input: PreparedCodeSearchInput,
  context: ToolExecutionContext,
  options: CodeSearchToolOptions
): Promise<CodeSearchExecutionResult | null> {
  const contentMatches = await (options.runRgContent ?? defaultRunRgContent)(targetPath, input, context);
  if (contentMatches === null) {
    return null;
  }
  const fileDiscovery = isDirectory
    ? await collectFiles(targetPath, input, context.signal, options.runRgFiles, "rg_only")
    : { backend: "rg" as const, files: [targetPath] };
  if (fileDiscovery === null) {
    return null;
  }
  return collectSearchResultFromMatches(fileDiscovery.files, contentMatches, input, context, "rg");
}

async function collectNodeSearchResult(
  targetPath: string,
  isDirectory: boolean,
  input: PreparedCodeSearchInput,
  matcher: RegExp,
  context: ToolExecutionContext,
  runRgFiles?: (directoryPath: string, input: PreparedCodeSearchInput) => Promise<string[] | null>
): Promise<CodeSearchExecutionResult> {
  const fileDiscovery = isDirectory
    ? await collectFiles(targetPath, input, context.signal, runRgFiles, "allow_node")
    : { backend: "node" as const, files: [targetPath] };
  if (fileDiscovery === null) {
    throw new AppError({
      code: "tool_execution_error",
      message: "Code search file discovery did not return a Node fallback result."
    });
  }
  const files = fileDiscovery.files;
    const matches: CodeSearchMatch[] = [];
    const filenameMatches: FilenameMatch[] = [];
    const fileCounts = new Map<string, FileCount>();
    const matchedFiles = new Map<string, string>();

    for (const filePath of files) {
      if (context.signal.aborted || shouldStopSearch(input, matches, filenameMatches)) {
        break;
      }
      const relativePath = toRelativePath(context.workspaceRoot, filePath);
      if (input.searchFilenames && matcher.test(relativePath)) {
        if (input.mode === "matches" && matches.length + filenameMatches.length < input.maxResults) {
          filenameMatches.push({ path: filePath, relativePath });
        }
        addMatchedFile(matchedFiles, relativePath, filePath);
        incrementFileCount(fileCounts, relativePath, filePath);
        matcher.lastIndex = 0;
      }
      const fileMatches = await searchFile(filePath, relativePath, matcher, input, context.signal);
      for (const match of fileMatches) {
        if (input.mode === "matches" && matches.length + filenameMatches.length < input.maxResults) {
          matches.push(match);
        }
        addMatchedFile(matchedFiles, relativePath, filePath);
        incrementFileCount(fileCounts, relativePath, filePath);
        if (shouldStopSearch(input, matches, filenameMatches)) {
          break;
        }
      }
    }

  return {
    backend: "node",
    fileCounts: [...fileCounts.values()],
    filenameMatches,
    files,
    matchedFiles: [...matchedFiles.entries()].map(([relativePath, path]) => ({ path, relativePath })),
    matches
  };
}

function collectSearchResultFromMatches(
  files: string[],
  contentMatches: CodeSearchMatch[],
  input: PreparedCodeSearchInput,
  context: ToolExecutionContext,
  backend: "node" | "rg"
): CodeSearchExecutionResult {
  const matches: CodeSearchMatch[] = [];
  const filenameMatches: FilenameMatch[] = [];
  const fileCounts = new Map<string, FileCount>();
  const matchedFiles = new Map<string, string>();

  for (const filePath of files) {
    const relativePath = toRelativePath(context.workspaceRoot, filePath);
    if (input.searchFilenames) {
      const filenameMatcher = input.regex
        ? new RegExp(input.query, input.caseSensitive ? "u" : "iu")
        : literalMatcher(input.query, input.caseSensitive);
      if (filenameMatcher.test(relativePath)) {
        if (input.mode === "matches" && matches.length + filenameMatches.length < input.maxResults) {
          filenameMatches.push({ path: filePath, relativePath });
        }
        addMatchedFile(matchedFiles, relativePath, filePath);
        incrementFileCount(fileCounts, relativePath, filePath);
      }
    }
  }

  for (const match of contentMatches) {
    if (input.mode === "matches" && matches.length + filenameMatches.length < input.maxResults) {
      matches.push(match);
    }
    addMatchedFile(matchedFiles, match.relativePath, match.path);
    incrementFileCount(fileCounts, match.relativePath, match.path);
  }

  return {
    backend,
    fileCounts: [...fileCounts.values()],
    filenameMatches,
    files,
    matchedFiles: [...matchedFiles.entries()].map(([relativePath, path]) => ({ path, relativePath })),
    matches
  };
}

function shouldStopSearch(
  input: PreparedCodeSearchInput,
  matches: CodeSearchMatch[],
  filenameMatches: FilenameMatch[]
): boolean {
  if (input.mode === "matches") {
    return matches.length + filenameMatches.length >= input.maxResults;
  }
  return false;
}

function addMatchedFile(matchedFiles: Map<string, string>, relativePath: string, path: string): void {
  if (!matchedFiles.has(relativePath)) {
    matchedFiles.set(relativePath, path);
  }
}

function incrementFileCount(fileCounts: Map<string, FileCount>, relativePath: string, path: string): void {
  const existing = fileCounts.get(relativePath);
  if (existing === undefined) {
    fileCounts.set(relativePath, {
      count: 1,
      path,
      relativePath
    });
    return;
  }
  existing.count += 1;
}

function buildModeOutput(
  mode: CodeSearchMode,
  input: {
    fileCounts: FileCount[];
    filenameMatches: FilenameMatch[];
    matchedFiles: FilenameMatch[];
    matches: CodeSearchMatch[];
    maxResults: number;
  }
): JsonObject {
  if (mode === "files") {
    return {
      fileCount: Math.min(input.matchedFiles.length, input.maxResults),
      files: input.matchedFiles.slice(0, input.maxResults),
      truncated: input.matchedFiles.length > input.maxResults
    };
  }
  if (mode === "count") {
    return {
      fileCounts: input.fileCounts.slice(0, input.maxResults),
      totalMatchCount: input.fileCounts.reduce((total, item) => total + item.count, 0),
      truncated: input.fileCounts.length > input.maxResults
    };
  }
  return {
    filenameMatches: input.filenameMatches,
    matchCount: input.matches.length,
    matches: input.matches,
    truncated: input.matches.length + input.filenameMatches.length >= input.maxResults
  };
}

function summarizeSearchResult(
  mode: CodeSearchMode,
  query: string,
  output: JsonObject,
  searchBackend: "node" | "rg"
): string {
  let summary: string;
  if (mode === "files") {
    const fileCount = typeof output.fileCount === "number" ? output.fileCount : 0;
    summary = `Found ${fileCount} matching files for "${query}"`;
  } else if (mode === "count") {
    const totalMatchCount = typeof output.totalMatchCount === "number" ? output.totalMatchCount : 0;
    summary = `Found ${totalMatchCount} total matches for "${query}"`;
  } else {
    const matchCount = typeof output.matchCount === "number" ? output.matchCount : 0;
    const filenameMatches = Array.isArray(output.filenameMatches) ? output.filenameMatches.length : 0;
    summary = `Found ${matchCount} content matches and ${filenameMatches} filename matches for "${query}"`;
  }
  if (searchBackend === "node") {
    return `${summary}; ${formatRipgrepFallbackSummarySuffix()}`;
  }
  return summary;
}

async function collectFiles(
  directoryPath: string,
  input: PreparedCodeSearchInput,
  signal: AbortSignal,
  runRgFiles?: (directoryPath: string, input: PreparedCodeSearchInput) => Promise<string[] | null>,
  fallbackMode: "allow_node" | "rg_only" = "allow_node"
): Promise<{ backend: "node" | "rg"; files: string[] } | null> {
  if (signal.aborted) {
    throw new AppError({
      code: "interrupt",
      message: "Code search interrupted."
    });
  }
  const rgFiles = await (runRgFiles ?? defaultRunRgFiles)(directoryPath, input);
  if (rgFiles !== null) {
    return {
      backend: "rg",
      files: await filterCandidateFiles(directoryPath, rgFiles, input, signal)
    };
  }

  if (fallbackMode === "rg_only") {
    return null;
  }

  return {
    backend: "node",
    files: await collectFilesWithNode(directoryPath, input, signal)
  };
}

async function collectFilesWithNode(
  directoryPath: string,
  input: PreparedCodeSearchInput,
  signal: AbortSignal
): Promise<string[]> {
  const files: string[] = [];
  const entries = (await fs.readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    if (signal.aborted) {
      break;
    }
    const nextPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      files.push(...(await collectFilesWithNode(nextPath, input, signal)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = toRelativePath(input.plan.resolvedPath, nextPath);
    if (!passesGlobFilters(relativePath, input.includeGlobs, input.excludeGlobs)) {
      continue;
    }
    const stat = await fs.stat(nextPath);
    if (stat.size > input.maxFileSizeBytes || isLikelyBinaryPath(nextPath)) {
      continue;
    }
    files.push(nextPath);
  }
  return files;
}

async function defaultRunRgFiles(
  directoryPath: string,
  input: PreparedCodeSearchInput
): Promise<string[] | null> {
  const args = [
    "--files",
    "--hidden",
    ...[...IGNORED_DIRECTORIES].flatMap((directory) => ["--glob", `!${directory}/**`]),
    ...input.includeGlobs.flatMap((glob) => ["--glob", normalizePath(glob)]),
    ...input.excludeGlobs.flatMap((glob) => ["--glob", `!${normalizePath(glob)}`])
  ];

  try {
    const result = await execFileAsync("rg", args, {
      cwd: directoryPath,
      encoding: "utf8",
      maxBuffer: 5_000_000,
      windowsHide: true
    });
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => join(directoryPath, line));
  } catch {
    return null;
  }
}

async function defaultRunRgContent(
  targetPath: string,
  input: PreparedCodeSearchInput,
  context: ToolExecutionContext
): Promise<CodeSearchMatch[] | null> {
  const stat = await fs.stat(targetPath);
  const cwd = stat.isDirectory() ? targetPath : dirname(targetPath);
  const target = stat.isDirectory() ? "." : basename(targetPath);
  const args = [
    "--json",
    "--line-number",
    "--with-filename",
    "--hidden",
    "--color",
    "never",
    "--max-filesize",
    String(input.maxFileSizeBytes),
    ...[...IGNORED_DIRECTORIES].flatMap((directory) => ["--glob", `!${directory}/**`]),
    ...input.includeGlobs.flatMap((glob) => ["--glob", normalizePath(glob)]),
    ...input.excludeGlobs.flatMap((glob) => ["--glob", `!${normalizePath(glob)}`]),
    ...(input.caseSensitive ? [] : ["-i"]),
    ...(input.regex ? [] : ["--fixed-strings"]),
    ...(input.contextLines > 0 ? ["-C", String(input.contextLines)] : []),
    "--",
    input.query,
    target
  ];

  try {
    const result = await execFileAsync("rg", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20_000_000,
      windowsHide: true
    });
    return parseRgJsonMatches(result.stdout, cwd, context.workspaceRoot, input.contextLines);
  } catch (error) {
    const exitCode = readProcessExitCode(error);
    const stdout = readProcessStdout(error);
    if (exitCode === 1 && stdout !== null) {
      return parseRgJsonMatches(stdout, cwd, context.workspaceRoot, input.contextLines);
    }
    // Missing rg (ENOENT) and other rg failures fall through to the Node walker.
    return null;
  }
}

function parseRgJsonMatches(
  stdout: string,
  cwd: string,
  workspaceRoot: string,
  contextLines: number
): CodeSearchMatch[] {
  const matches: CodeSearchMatch[] = [];
  const beforeContextByPath = new Map<string, string[]>();
  const pendingAfterByPath = new Map<string, CodeSearchMatch[]>();

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const event = parseRgJsonEvent(line);
    if (event === null) {
      continue;
    }
    const pathText = readRgText(event.data?.path);
    const lineText = readRgText(event.data?.lines);
    if (pathText === null || lineText === null) {
      continue;
    }
    const path = join(cwd, pathText);
    const relativePath = toRelativePath(workspaceRoot, path);
    const cleanLine = trimLineEnding(lineText);

    if (event.type === "match") {
      const match: CodeSearchMatch = {
        afterContext: [],
        beforeContext: (beforeContextByPath.get(pathText) ?? []).slice(-contextLines),
        line: cleanLine,
        lineNumber: typeof event.data?.line_number === "number" ? event.data.line_number : 0,
        matchText: readFirstRgSubmatch(event) ?? cleanLine,
        path,
        relativePath
      };
      matches.push(match);
      if (contextLines > 0) {
        const pending = pendingAfterByPath.get(pathText) ?? [];
        pending.push(match);
        pendingAfterByPath.set(pathText, pending);
      }
      beforeContextByPath.set(pathText, []);
      continue;
    }

    if (event.type === "context") {
      const pending = pendingAfterByPath.get(pathText) ?? [];
      for (const match of pending) {
        if (match.afterContext.length < contextLines) {
          match.afterContext.push(cleanLine);
        }
      }
      pendingAfterByPath.set(
        pathText,
        pending.filter((match) => match.afterContext.length < contextLines)
      );
      const beforeContext = beforeContextByPath.get(pathText) ?? [];
      beforeContext.push(cleanLine);
      beforeContextByPath.set(pathText, beforeContext.slice(-contextLines));
    }
  }

  return matches;
}

interface RgJsonEvent {
  data?: {
    line_number?: unknown;
    lines?: { text?: unknown };
    path?: { text?: unknown };
    submatches?: Array<{ match?: { text?: unknown } }>;
  };
  type?: unknown;
}

function parseRgJsonEvent(line: string): RgJsonEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RgJsonEvent)
      : null;
  } catch {
    return null;
  }
}

function readRgText(value: { text?: unknown } | undefined): string | null {
  return typeof value?.text === "string" ? value.text : null;
}

function readFirstRgSubmatch(event: RgJsonEvent): string | null {
  const text = event.data?.submatches?.[0]?.match?.text;
  return typeof text === "string" ? text : null;
}

function trimLineEnding(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

function readProcessExitCode(error: unknown): number | null {
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "number" ? candidate.code : null;
}

function readProcessStdout(error: unknown): string | null {
  const candidate = error as { stdout?: unknown };
  return typeof candidate.stdout === "string" ? candidate.stdout : null;
}

async function filterCandidateFiles(
  rootPath: string,
  files: string[],
  input: PreparedCodeSearchInput,
  signal: AbortSignal
): Promise<string[]> {
  const filtered: string[] = [];
  for (const filePath of files) {
    if (signal.aborted) {
      break;
    }
    const relativePath = toRelativePath(rootPath, filePath);
    if (!passesGlobFilters(relativePath, input.includeGlobs, input.excludeGlobs)) {
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > input.maxFileSizeBytes || isLikelyBinaryPath(filePath)) {
        continue;
      }
      filtered.push(filePath);
    } catch {
      continue;
    }
  }
  return filtered;
}

async function searchFile(
  filePath: string,
  relativePath: string,
  matcher: RegExp,
  input: PreparedCodeSearchInput,
  signal: AbortSignal
): Promise<CodeSearchMatch[]> {
  if (signal.aborted) {
    return [];
  }
  const relativeToRoot = toRelativePath(input.plan.resolvedPath, filePath);
  if (!passesGlobFilters(relativeToRoot, input.includeGlobs, input.excludeGlobs)) {
    return [];
  }
  const stat = await fs.stat(filePath);
  if (stat.size > input.maxFileSizeBytes || isLikelyBinaryPath(filePath)) {
    return [];
  }
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  if (content.includes("\u0000")) {
    return [];
  }
  const lines = content.split(/\r?\n/u);
  const matches: CodeSearchMatch[] = [];
  const maxFileMatches =
    input.mode === "count" ? Number.POSITIVE_INFINITY : input.mode === "files" ? 1 : input.maxResults;
  for (const [index, line] of lines.entries()) {
    matcher.lastIndex = 0;
    const match = matcher.exec(line);
    if (match === null) {
      continue;
    }
    matches.push({
      afterContext: lines.slice(index + 1, index + 1 + input.contextLines),
      beforeContext: lines.slice(Math.max(0, index - input.contextLines), index),
      line,
      lineNumber: index + 1,
      matchText: match[0],
      path: filePath,
      relativePath
    });
    if (matches.length >= maxFileMatches) {
      break;
    }
  }
  return matches;
}

function literalMatcher(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(escapeRegExp(query), caseSensitive ? "u" : "iu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function passesGlobFilters(relativePath: string, includeGlobs: string[], excludeGlobs: string[]): boolean {
  const normalized = normalizePath(relativePath);
  if (excludeGlobs.some((pattern) => globToRegExp(pattern).test(normalized))) {
    return false;
  }
  if (includeGlobs.length === 0) {
    return true;
  }
  return includeGlobs.some((pattern) => globToRegExp(pattern).test(normalized));
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`, "u");
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function toRelativePath(root: string, path: string): string {
  const relativePath = relative(root, path);
  return normalizePath(relativePath.length === 0 ? basename(path) : relativePath);
}

function clampContextLines(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value;
  }
  return Math.min(value, 5);
}

function isLikelyBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".class",
  ".dll",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".so",
  ".webp",
  ".zip"
]);

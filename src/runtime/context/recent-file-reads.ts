import { promises as fs } from "node:fs";

import type { ConversationMessage } from "../../types/index.js";

export const RECENT_FILE_READS_SOURCE_TYPE = "recent_file_reads";

export interface ContextRetentionConfig {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
  maxBytesPerFileUnderGuard: number;
  maxTotalBytesUnderGuard: number;
  toolOutputMaxTokens: number;
  toolResultKeepGroups: number;
}

export const DEFAULT_CONTEXT_RETENTION: ContextRetentionConfig = {
  maxBytesPerFile: 24_000,
  maxBytesPerFileUnderGuard: 24_000,
  maxFiles: 8,
  maxTotalBytes: 128_000,
  maxTotalBytesUnderGuard: 200_000,
  toolOutputMaxTokens: 2_500,
  toolResultKeepGroups: 5
};

export type RecentFileReadCacheMode = "normal" | "write_required";

export interface RecentFileReadEntry {
  path: string;
  content: string;
  readAt: string;
  toolCallId: string | null;
  bytes: number;
  truncated: boolean;
}

interface InternalEntry extends RecentFileReadEntry {
  order: number;
}

export class RecentFileReadCache {
  private readonly entries = new Map<string, InternalEntry>();
  private mode: RecentFileReadCacheMode = "normal";
  private nextOrder = 0;

  public constructor(private readonly config: ContextRetentionConfig = DEFAULT_CONTEXT_RETENTION) {}

  public setMode(mode: RecentFileReadCacheMode): void {
    this.mode = mode;
  }

  public getMode(): RecentFileReadCacheMode {
    return this.mode;
  }

  public record(path: string, content: string, toolCallId: string | null = null): void {
    const normalizedPath = path.trim();
    if (normalizedPath.length === 0) {
      return;
    }

    const previous = this.entries.get(normalizedPath);
    const usedBytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const usedWithoutPrevious = usedBytes - (previous?.bytes ?? 0);
    const remainingTotalBudget = Math.max(
      0,
      this.currentTotalBudget() - usedWithoutPrevious
    );
    const clipBudget = Math.min(this.currentPerFileBudget(), remainingTotalBudget);
    const { content: clipped, truncated } = clipFileContent(
      content,
      Math.max(clipBudget, 1)
    );
    const entry: InternalEntry = {
      bytes: Buffer.byteLength(clipped, "utf8"),
      content: clipped,
      order: ++this.nextOrder,
      path: normalizedPath,
      readAt: new Date().toISOString(),
      toolCallId,
      truncated
    };
    this.entries.set(normalizedPath, entry);
    this.enforceLimits();
  }

  public evict(path: string): void {
    this.entries.delete(path.trim());
  }

  /**
   * Keep only cache entries whose path matches `keepPath` (relative or absolute).
   * Used after a successful write so filler reads do not stay pinned.
   */
  public retainMatching(keepPath: string): string[] {
    const keep = keepPath.trim();
    if (keep.length === 0) {
      return [];
    }
    const evicted: string[] = [];
    for (const path of [...this.entries.keys()]) {
      if (!recentFilePathsMatch(path, keep)) {
        this.entries.delete(path);
        evicted.push(path);
      }
    }
    return evicted;
  }

  public list(): RecentFileReadEntry[] {
    const budget = this.currentTotalBudget();
    const sorted = [...this.entries.values()].sort((left, right) => right.order - left.order);
    const selected: RecentFileReadEntry[] = [];
    let usedBytes = 0;

    for (const entry of sorted) {
      if (selected.length >= this.config.maxFiles) {
        break;
      }
      if (selected.length > 0 && usedBytes + entry.bytes > budget) {
        continue;
      }
      selected.push({
        bytes: entry.bytes,
        content: entry.content,
        path: entry.path,
        readAt: entry.readAt,
        toolCallId: entry.toolCallId,
        truncated: entry.truncated
      });
      usedBytes += entry.bytes;
    }

    return selected;
  }

  public listPaths(): string[] {
    return this.list().map((entry) => entry.path);
  }

  public async refetchFromDisk(): Promise<{ evicted: string[]; refetched: string[] }> {
    const refetched: string[] = [];
    const evicted: string[] = [];
    const paths = [...this.entries.keys()];

    for (const path of paths) {
      try {
        const content = await fs.readFile(path, "utf8");
        this.record(path, content, this.entries.get(path)?.toolCallId ?? null);
        refetched.push(path);
      } catch {
        this.entries.delete(path);
        evicted.push(path);
      }
    }

    return { evicted, refetched };
  }

  private currentPerFileBudget(): number {
    return this.mode === "write_required"
      ? this.config.maxBytesPerFileUnderGuard
      : this.config.maxBytesPerFile;
  }

  private currentTotalBudget(): number {
    return this.mode === "write_required"
      ? this.config.maxTotalBytesUnderGuard
      : this.config.maxTotalBytes;
  }

  private enforceLimits(): void {
    const sorted = [...this.entries.values()].sort((left, right) => right.order - left.order);
    while (sorted.length > this.config.maxFiles) {
      const removed = sorted.pop();
      if (removed !== undefined) {
        this.entries.delete(removed.path);
      }
    }

    let totalBytes = sorted.reduce((sum, entry) => sum + entry.bytes, 0);
    while (totalBytes > this.currentTotalBudget() && sorted.length > 1) {
      const removed = sorted.pop();
      if (removed !== undefined) {
        this.entries.delete(removed.path);
        totalBytes -= removed.bytes;
      }
    }
  }
}

export function isPinnedRecentFilesMessage(message: ConversationMessage): boolean {
  return (
    message.role === "system" &&
    message.metadata?.sourceType === RECENT_FILE_READS_SOURCE_TYPE &&
    message.metadata?.pinned === true
  );
}

export function splitPinnedMessages(messages: ConversationMessage[]): {
  pinned: ConversationMessage[];
  rest: ConversationMessage[];
} {
  const pinned: ConversationMessage[] = [];
  const rest: ConversationMessage[] = [];
  for (const message of messages) {
    if (isPinnedRecentFilesMessage(message)) {
      pinned.push(message);
    } else {
      rest.push(message);
    }
  }
  return { pinned, rest };
}

export function buildPinnedRecentFilesMessage(entries: RecentFileReadEntry[]): ConversationMessage | null {
  if (entries.length === 0) {
    return null;
  }

  const sortedEntries = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const blocks = sortedEntries.map((entry) => {
    const truncationNote = entry.truncated ? " (truncated)" : "";
    return [`### ${entry.path}${truncationNote}`, "```", entry.content, "```"].join("\n");
  });

  return {
    content: [
      "Recently read files (most recent first, current disk contents). Use these excerpts for patches — do not edit from memory.",
      ...blocks
    ].join("\n\n"),
    metadata: {
      pinned: true,
      privacyLevel: "internal",
      retentionKind: "session",
      sourceType: RECENT_FILE_READS_SOURCE_TYPE
    },
    role: "system"
  };
}

export function syncPinnedRecentFilesMessage(
  messages: ConversationMessage[],
  cache: RecentFileReadCache | null
): ConversationMessage | null {
  const existingPinned = messages.find((message) => isPinnedRecentFilesMessage(message)) ?? null;

  if (cache === null) {
    if (existingPinned !== null) {
      const withoutPinned = messages.filter((message) => !isPinnedRecentFilesMessage(message));
      messages.length = 0;
      messages.push(...withoutPinned);
    }
    return null;
  }

  const pinned = buildPinnedRecentFilesMessage(cache.list());
  if (pinned === null) {
    if (existingPinned !== null) {
      const withoutPinned = messages.filter((message) => !isPinnedRecentFilesMessage(message));
      messages.length = 0;
      messages.push(...withoutPinned);
    }
    return null;
  }

  if (existingPinned !== null && existingPinned.content === pinned.content) {
    return existingPinned;
  }

  const withoutPinned = messages.filter((message) => !isPinnedRecentFilesMessage(message));
  messages.length = 0;
  messages.push(...withoutPinned);

  const initialSystemIndex = messages.findIndex(
    (message) =>
      message.role === "system" &&
      message.metadata?.sourceType !== RECENT_FILE_READS_SOURCE_TYPE
  );
  const insertAt = initialSystemIndex >= 0 ? initialSystemIndex + 1 : 0;
  messages.splice(insertAt, 0, pinned);
  return pinned;
}

export function clipFileContent(
  content: string,
  maxBytes: number
): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= maxBytes) {
    return { content, truncated: false };
  }

  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = Math.floor(maxBytes * 0.25);
  const head = sliceUtf8ByBytes(content, 0, headBytes);
  const tail = sliceUtf8ByBytes(content, Math.max(0, bytes - tailBytes), tailBytes);
  const elided = bytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  let clipped = `${head}\n... <${elided} bytes elided> ...\n${tail}`;
  if (Buffer.byteLength(clipped, "utf8") > maxBytes) {
    clipped = sliceUtf8ByBytes(clipped, 0, maxBytes);
  }
  return {
    content: clipped,
    truncated: true
  };
}

function sliceUtf8ByBytes(value: string, startByte: number, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  const slice = buffer.subarray(startByte, startByte + maxBytes);
  return slice.toString("utf8");
}

export function recentFilePathsMatch(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function formatRecentlyReadFilesSummary(entries: RecentFileReadEntry[]): string {
  if (entries.length === 0) {
    return "[none]";
  }
  return entries
    .map((entry) => `${entry.path} (${entry.bytes} bytes${entry.truncated ? ", truncated" : ""})`)
    .join("; ");
}

export function recordRecentFileReadFromToolCall(
  cache: RecentFileReadCache,
  toolName: string,
  _toolInput: { path?: unknown },
  output: unknown,
  toolCallId: string | null = null
): void {
  if (toolName !== "read_file") {
    return;
  }
  const outputRecord = output as { content?: unknown; path?: unknown };
  if (typeof outputRecord.content !== "string" || typeof outputRecord.path !== "string") {
    return;
  }
  cache.record(outputRecord.path, outputRecord.content, toolCallId);
}

export function isVagueImplementationInput(input: string): boolean {
  const compact = input.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return false;
  }
  if (compact.length > 80) {
    return false;
  }
  const vaguePatterns = [
    /^修复(?:一下|下)?(?:这个)?(?:bug|问题)?[.!?。！？]*$/iu,
    /^修(?:一下|下)?[.!?。！？]*$/iu,
    /^fix(?:\s+this)?(?:\s+bug)?[.!?]*$/iu,
    /^继续[.!?。！？]*$/iu,
    /^continue[.!?]*$/iu
  ];
  return vaguePatterns.some((pattern) => pattern.test(compact));
}

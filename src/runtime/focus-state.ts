import { basename, extname, isAbsolute, normalize, relative, resolve } from "node:path";

import type {
  ContextAssemblyDebugView,
  ContextDebugFragment,
  ContextFragment,
  ConversationMessage,
  JsonObject
} from "../types/index.js";

const MAX_RECENT_TARGETS = 5;
const SCORE_DECAY_PER_TURN = 0.1;
const MIN_SCORE = 0.5;
const ACTIVE_TARGET_MIN_GAP = 0.15;

const FILE_DEICTIC_PATTERNS = [
  /\bthis document\b/iu,
  /\bthis file\b/iu,
  /\bcurrent file\b/iu,
  /\u8fd9\u4e2a\u6587\u6863/u,
  /\u8fd9\u4e2a\u6587\u4ef6/u,
  /\u8be5\u6587\u6863/u
] as const;
const FUNCTION_DEICTIC_PATTERNS = [
  /\bthis function\b/iu,
  /\u8fd9\u4e2a\u51fd\u6570/u,
  /\u8be5\u51fd\u6570/u
] as const;
const CLASS_DEICTIC_PATTERNS = [/\bthis class\b/iu, /\u8fd9\u4e2a\u7c7b/u, /\u8be5\u7c7b/u] as const;
const URL_DEICTIC_PATTERNS = [
  /\bthis url\b/iu,
  /\bthis link\b/iu,
  /\bthis page\b/iu,
  /\u8fd9\u4e2a\u94fe\u63a5/u,
  /\u8fd9\u4e2a\u7f51\u5740/u,
  /\u8fd9\u4e2a\u9875\u9762/u
] as const;

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/giu;
const FILE_PATTERN =
  /(?<!https?:\/\/)(?<![\w/.-])(?:\.{0,2}\/)?[\w@./-]+\.[A-Za-z0-9]{1,12}(?![\w.-])/gu;
const EXPLICIT_FUNCTION_PATTERNS = [
  /`([A-Za-z_$][\w$]*)`\s*(?:\u51fd\u6570|\u65b9\u6cd5|function)/gu,
  /(?:\u51fd\u6570|\u65b9\u6cd5|function)\s+`?([A-Za-z_$][\w$]*)`?/gu
] as const;
const EXPLICIT_CLASS_PATTERNS = [
  /`([A-Z][\w$]*)`\s*(?:\u7c7b|class)/gu,
  /(?:\u7c7b|class)\s+`?([A-Z][\w$]*)`?/gu
] as const;

export type FocusTargetKind = "class" | "file" | "function" | "url";
export type FocusTargetSource =
  | "explicit_user"
  | "file_read"
  | "file_write"
  | "symbol_read"
  | "web_fetch";

export interface FocusTarget {
  id: string;
  kind: FocusTargetKind;
  label: string;
  lineEnd?: number;
  lineStart?: number;
  lastTouchedAt: string;
  occurrenceCount?: number;
  path?: string;
  score: number;
  source: FocusTargetSource;
  symbolName?: string;
  taskId: string;
  url?: string;
  userTurnIndex: number;
}

export interface FocusState {
  activeTarget: FocusTarget | null;
  recentTargets: FocusTarget[];
  userTurnIndex: number;
}

export interface FocusTurnResolution {
  activeContextFragments: ContextDebugFragment[];
  clarificationMessage: string | null;
  filteredMemoryFragments: ContextAssemblyDebugView["filteredOutFragments"];
  focusState: FocusState;
  memoryContext: ContextFragment[];
  providerMessages: ConversationMessage[];
}

interface ExtractedTarget {
  kind: FocusTargetKind;
  path?: string;
  symbolName?: string;
  url?: string;
}

export function emptyFocusState(): FocusState {
  return {
    activeTarget: null,
    recentTargets: [],
    userTurnIndex: 0
  };
}

export function restoreFocusState(metadata: unknown): FocusState {
  if (typeof metadata !== "object" || metadata === null) {
    return emptyFocusState();
  }
  const record = metadata as Record<string, unknown>;
  const recentTargets = Array.isArray(record.recentTargets)
    ? record.recentTargets
        .map((item) => parseFocusTarget(item))
        .filter((item): item is FocusTarget => item !== null)
    : [];
  const userTurnIndex =
    typeof record.userTurnIndex === "number" && Number.isFinite(record.userTurnIndex)
      ? Math.max(0, Math.trunc(record.userTurnIndex))
      : 0;
  return recomputeActiveTarget({
    activeTarget: null,
    recentTargets,
    userTurnIndex
  });
}

export function serializeFocusState(state: FocusState): JsonObject {
  return {
    activeTarget: state.activeTarget,
    recentTargets: state.recentTargets,
    userTurnIndex: state.userTurnIndex
  } as unknown as JsonObject;
}

export function rebuildFocusStateFromMessages(
  messages: ConversationMessage[],
  cwd: string,
  seed?: FocusState
): FocusState {
  let state = seed ?? emptyFocusState();
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.toolName !== "string") {
      continue;
    }
    const output = parseToolMessageOutput(message.content);
    if (output === null) {
      continue;
    }
    state = updateFocusStateFromToolResult(state, {
      cwd,
      output,
      taskId: "resume-task",
      timestamp: new Date().toISOString(),
      toolName: message.toolName
    });
  }
  return state;
}

export function prepareFocusTurn(input: {
  cwd: string;
  memoryContext: ContextFragment[];
  messages: ConversationMessage[];
  now: string;
  state: FocusState;
  taskId: string;
  userInput: string;
}): FocusTurnResolution {
  let focusState = beginTurn(input.state);
  const explicitTargets = extractExplicitTargets(input.userInput, input.cwd);
  let resolvedTarget: FocusTarget | null = null;

  for (const target of explicitTargets) {
    const focusTarget = createFocusTargetFromExplicit(
      target,
      input.cwd,
      taskIdForTarget(target, input.taskId, focusState),
      input.now,
      focusState.userTurnIndex,
      focusState
    );
    if (focusTarget !== null) {
      focusState = addOrUpdateTarget(focusState, focusTarget);
      if (explicitTargets.length === 1) {
        resolvedTarget =
          focusState.recentTargets.find(
            (candidate) => candidate.id === focusTarget.id && candidate.kind === focusTarget.kind
          ) ?? focusTarget;
      }
    }
  }

  const deicticKind = detectDeicticKind(input.userInput);
  if (explicitTargets.length === 0 && deicticKind !== null) {
    const candidates = listCandidatesForKind(focusState, deicticKind);
    if (candidates.length === 0) {
      return {
        activeContextFragments: buildActiveContextFragments(focusState, null),
        clarificationMessage: genericClarificationMessage(deicticKind),
        filteredMemoryFragments: [],
        focusState,
        memoryContext: input.memoryContext,
        providerMessages: input.messages
      };
    }
    const first = candidates[0];
    const second = candidates[1] ?? null;
    const ambiguous =
      first === undefined ||
      first.score < MIN_SCORE ||
      (second !== null && first.score - second.score < ACTIVE_TARGET_MIN_GAP) ||
      (first.kind !== "file" && (first.occurrenceCount ?? 1) > 1);
    if (ambiguous) {
      return {
        activeContextFragments: buildActiveContextFragments(focusState, null),
        clarificationMessage: buildClarificationMessage(deicticKind, candidates, input.cwd),
        filteredMemoryFragments: [],
        focusState,
        memoryContext: input.memoryContext,
        providerMessages: input.messages
      };
    }
    focusState = addOrUpdateTarget(focusState, {
      ...first,
      score: Math.min(1, first.score + 0.05)
    });
    resolvedTarget =
      focusState.recentTargets.find(
        (candidate) => candidate.id === first.id && candidate.kind === first.kind
      ) ?? first;
  }

  const activeTarget = resolvedTarget ?? focusState.activeTarget;
  const { filtered, kept } = filterConflictingMemoryContext(
    input.memoryContext,
    activeTarget,
    deicticKind
  );

  return {
    activeContextFragments: buildActiveContextFragments(focusState, activeTarget),
    clarificationMessage: null,
    filteredMemoryFragments: filtered.map((fragment) => toFilteredFragment(fragment, activeTarget)),
    focusState,
    memoryContext: kept,
    providerMessages:
      activeTarget === null
        ? input.messages
        : [
            {
              content: buildProviderHint(activeTarget, input.cwd),
              metadata: {
                privacyLevel: "internal",
                retentionKind: "working",
                sourceType: "system_prompt"
              },
              role: "system"
            },
            ...input.messages
          ]
  };
}

export function updateFocusStateFromToolResult(
  state: FocusState,
  input: {
    cwd: string;
    output: unknown;
    taskId: string;
    timestamp: string;
    toolName: string;
  }
): FocusState {
  if (input.toolName === "file_write") {
    const output = asRecord(input.output);
    const path = typeof output?.path === "string" ? normalizePath(output.path, input.cwd) : null;
    return path === null
      ? state
      : addOrUpdateTarget(
          state,
          createFileTarget(
            path,
            "file_write",
            0.95,
            input.cwd,
            input.taskId,
            input.timestamp,
            state.userTurnIndex
          )
        );
  }

  if (input.toolName === "file_read") {
    const output = asRecord(input.output);
    const path = typeof output?.path === "string" ? normalizePath(output.path, input.cwd) : null;
    if (path === null) {
      return state;
    }
    let nextState = addOrUpdateTarget(
      state,
      createFileTarget(
        path,
        "file_read",
        0.85,
        input.cwd,
        input.taskId,
        input.timestamp,
        state.userTurnIndex
      )
    );
    if (typeof output?.content === "string") {
      const offset = typeof output.offset === "number" ? output.offset : 0;
      for (const symbol of extractSymbolsFromContent(
        output.content,
        path,
        input.cwd,
        input.taskId,
        input.timestamp,
        state.userTurnIndex,
        offset
      )) {
        nextState = addOrUpdateTarget(nextState, symbol);
      }
    }
    return nextState;
  }

  if (input.toolName === "web_fetch") {
    const output = asRecord(input.output);
    const url = typeof output?.url === "string" ? normalizeUrl(output.url) : null;
    return url === null
      ? state
      : addOrUpdateTarget(state, {
          id: url,
          kind: "url",
          label: url,
          lastTouchedAt: input.timestamp,
          score: 0.9,
          source: "web_fetch",
          taskId: input.taskId,
          url,
          userTurnIndex: state.userTurnIndex
        });
  }

  return state;
}

function filterConflictingMemoryContext(
  memoryContext: ContextFragment[],
  activeTarget: FocusTarget | null,
  deicticKind: FocusTargetKind | null
): {
  filtered: ContextFragment[];
  kept: ContextFragment[];
} {
  if (activeTarget === null || deicticKind === null) {
    return {
      filtered: [],
      kept: memoryContext
    };
  }

  const filtered: ContextFragment[] = [];
  const kept: ContextFragment[] = [];
  for (const fragment of memoryContext) {
    const extracted = extractExplicitTargets(fragment.text, "");
    if (extracted.some((candidate) => isConflictingCandidate(candidate, activeTarget))) {
      filtered.push(fragment);
      continue;
    }
    kept.push(fragment);
  }
  return { filtered, kept };
}

function beginTurn(state: FocusState): FocusState {
  const userTurnIndex = state.userTurnIndex + 1;
  const recentTargets = state.recentTargets
    .map((target) => ({
      ...target,
      score: Number(Math.max(0, target.score - SCORE_DECAY_PER_TURN).toFixed(2)),
      userTurnIndex
    }))
    .filter((target) => target.score >= MIN_SCORE);
  return recomputeActiveTarget({
    activeTarget: null,
    recentTargets,
    userTurnIndex
  });
}

function addOrUpdateTarget(state: FocusState, target: FocusTarget): FocusState {
  const existing = state.recentTargets.find((item) => item.id === target.id && item.kind === target.kind);
  const merged: FocusTarget =
    existing === undefined
        ? target
      : {
          ...existing,
          ...target,
          ...((target.lineEnd ?? existing.lineEnd) !== undefined
            ? { lineEnd: target.lineEnd ?? existing.lineEnd }
            : {}),
          ...((target.lineStart ?? existing.lineStart) !== undefined
            ? { lineStart: target.lineStart ?? existing.lineStart }
            : {}),
          ...(Math.max(existing.occurrenceCount ?? 1, target.occurrenceCount ?? 1) > 1
            ? { occurrenceCount: Math.max(existing.occurrenceCount ?? 1, target.occurrenceCount ?? 1) }
            : {}),
          score: Number(Math.min(1, Math.max(target.score, existing.score + 0.05)).toFixed(2)),
          userTurnIndex: state.userTurnIndex
        };
  return recomputeActiveTarget({
    activeTarget: null,
    recentTargets: [
      merged,
      ...state.recentTargets.filter((item) => !(item.id === target.id && item.kind === target.kind))
    ]
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_RECENT_TARGETS),
    userTurnIndex: state.userTurnIndex
  });
}

function recomputeActiveTarget(state: FocusState): FocusState {
  const ordered = [...state.recentTargets].sort((left, right) => right.score - left.score);
  const first = ordered[0] ?? null;
  const second = ordered[1] ?? null;
  return {
    activeTarget:
      first !== null &&
      first.score >= MIN_SCORE &&
      (second === null || first.score - second.score >= ACTIVE_TARGET_MIN_GAP)
        ? first
        : null,
    recentTargets: ordered,
    userTurnIndex: state.userTurnIndex
  };
}

function detectDeicticKind(input: string): FocusTargetKind | null {
  if (FILE_DEICTIC_PATTERNS.some((pattern) => pattern.test(input))) {
    return "file";
  }
  if (FUNCTION_DEICTIC_PATTERNS.some((pattern) => pattern.test(input))) {
    return "function";
  }
  if (CLASS_DEICTIC_PATTERNS.some((pattern) => pattern.test(input))) {
    return "class";
  }
  if (URL_DEICTIC_PATTERNS.some((pattern) => pattern.test(input))) {
    return "url";
  }
  return null;
}

function extractExplicitTargets(input: string, cwd: string): ExtractedTarget[] {
  const targets: ExtractedTarget[] = [];
  for (const match of input.matchAll(URL_PATTERN)) {
    const url = match[0]?.trim();
    if (url !== undefined && url.length > 0) {
      targets.push({ kind: "url", url });
    }
  }
  const withoutUrls = input.replace(URL_PATTERN, " ");
  for (const match of withoutUrls.matchAll(FILE_PATTERN)) {
    const path = match[0]?.trim();
    if (path === undefined || extname(path).length === 0 || path.includes("://")) {
      continue;
    }
    targets.push({
      kind: "file",
      path: normalizePath(path, cwd || ".")
    });
  }
  for (const pattern of EXPLICIT_FUNCTION_PATTERNS) {
    for (const match of input.matchAll(pattern)) {
      const symbolName = match[1]?.trim();
      if (symbolName !== undefined) {
        targets.push({ kind: "function", symbolName });
      }
    }
  }
  for (const pattern of EXPLICIT_CLASS_PATTERNS) {
    for (const match of input.matchAll(pattern)) {
      const symbolName = match[1]?.trim();
      if (symbolName !== undefined) {
        targets.push({ kind: "class", symbolName });
      }
    }
  }
  return dedupeExtractedTargets(targets);
}

function dedupeExtractedTargets(targets: ExtractedTarget[]): ExtractedTarget[] {
  const seen = new Set<string>();
  const result: ExtractedTarget[] = [];
  for (const target of targets) {
    const key = `${target.kind}:${target.path ?? target.symbolName ?? target.url ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(target);
  }
  return result;
}

function createFocusTargetFromExplicit(
  target: ExtractedTarget,
  cwd: string,
  taskId: string,
  timestamp: string,
  userTurnIndex: number,
  focusState: FocusState
): FocusTarget | null {
  if (target.kind === "file" && target.path !== undefined) {
    return createFileTarget(target.path, "explicit_user", 1, cwd, taskId, timestamp, userTurnIndex);
  }
  if (target.kind === "url" && target.url !== undefined) {
    const url = normalizeUrl(target.url);
    if (url === null) {
      return null;
    }
    return {
      id: url,
      kind: "url",
      label: url,
      lastTouchedAt: timestamp,
      score: 1,
      source: "explicit_user",
      taskId,
      url,
      userTurnIndex
    };
  }
  if (target.symbolName === undefined) {
    return null;
  }
  const matchedSymbol = focusState.recentTargets.find(
    (candidate) =>
      candidate.kind === target.kind &&
      candidate.symbolName === target.symbolName &&
      (candidate.occurrenceCount ?? 1) === 1
  );
  return {
    id: matchedSymbol?.id ?? `${target.kind}:${target.symbolName}`,
    kind: target.kind,
    label:
      matchedSymbol?.label ??
      (matchedSymbol?.path !== undefined
        ? `${target.symbolName} (${displayPath(matchedSymbol.path, cwd)})`
        : target.symbolName),
    lastTouchedAt: timestamp,
    ...(matchedSymbol?.lineEnd !== undefined ? { lineEnd: matchedSymbol.lineEnd } : {}),
    ...(matchedSymbol?.lineStart !== undefined ? { lineStart: matchedSymbol.lineStart } : {}),
    ...(matchedSymbol?.path !== undefined ? { path: matchedSymbol.path } : {}),
    score: 1,
    source: "explicit_user",
    symbolName: target.symbolName,
    taskId,
    userTurnIndex
  };
}

function taskIdForTarget(target: ExtractedTarget, fallbackTaskId: string, focusState: FocusState): string {
  if (target.symbolName === undefined) {
    return fallbackTaskId;
  }
  return (
    focusState.recentTargets.find(
      (candidate) => candidate.symbolName === target.symbolName && candidate.kind === target.kind
    )?.taskId ?? fallbackTaskId
  );
}

function createFileTarget(
  path: string,
  source: FocusTargetSource,
  score: number,
  cwd: string,
  taskId: string,
  timestamp: string,
  userTurnIndex: number
): FocusTarget {
  return {
    id: path,
    kind: "file",
    label: displayPath(path, cwd),
    lastTouchedAt: timestamp,
    path,
    score,
    source,
    taskId,
    userTurnIndex
  };
}

function extractSymbolsFromContent(
  content: string,
  path: string,
  cwd: string,
  taskId: string,
  timestamp: string,
  userTurnIndex: number,
  offset: number
): FocusTarget[] {
  const symbols = new Map<string, FocusTarget>();
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const functionName = matchFunctionName(line);
    if (functionName !== null) {
      const id = `${path}::${functionName}`;
      const existing = symbols.get(id);
      symbols.set(id, {
        id,
        kind: "function",
        label: `${functionName} (${displayPath(path, cwd)})`,
        lastTouchedAt: timestamp,
        lineEnd: offset + index + 1,
        lineStart: offset + index + 1,
        occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
        path,
        score: 0.9,
        source: "symbol_read",
        symbolName: functionName,
        taskId,
        userTurnIndex
      });
    }
    const className = matchClassName(line);
    if (className !== null) {
      const id = `${path}::${className}`;
      const existing = symbols.get(id);
      symbols.set(id, {
        id,
        kind: "class",
        label: `${className} (${displayPath(path, cwd)})`,
        lastTouchedAt: timestamp,
        lineEnd: offset + index + 1,
        lineStart: offset + index + 1,
        occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
        path,
        score: 0.9,
        source: "symbol_read",
        symbolName: className,
        taskId,
        userTurnIndex
      });
    }
  }
  return [...symbols.values()];
}

function matchFunctionName(line: string): string | null {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/u,
    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/u,
    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u
  ] as const;
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

function matchClassName(line: string): string | null {
  const match = line.match(/^\s*(?:export\s+)?class\s+([A-Z][\w$]*)\b/u);
  return match?.[1] ?? null;
}

function buildProviderHint(target: FocusTarget, cwd: string): string {
  if (target.kind === "file") {
    return `Resolve references like "this file" or "this document" to ${displayPath(target.path ?? target.label, cwd)} unless the user names another file.`;
  }
  if (target.kind === "url") {
    return `Resolve references like "this link" or "this page" to ${target.url ?? target.label} unless the user names another URL.`;
  }
  return `Resolve references like "this ${target.kind}" to ${target.symbolName ?? target.label}${target.path ? ` in ${displayPath(target.path, cwd)}` : ""} unless the user names another ${target.kind}.`;
}

function buildActiveContextFragments(
  state: FocusState,
  resolvedTarget: FocusTarget | null
): ContextDebugFragment[] {
  return state.recentTargets.slice(0, 3).map((target, index) => ({
    label:
      index === 0 && resolvedTarget !== null && target.id === resolvedTarget.id
        ? "Resolved target"
        : `Focus candidate ${index + 1}`,
    metadata: {
      kind: target.kind,
      lineEnd: target.lineEnd ?? null,
      lineStart: target.lineStart ?? null,
      path: target.path ?? null,
      score: Number(target.score.toFixed(2)),
      source: target.source,
      symbolName: target.symbolName ?? null,
      url: target.url ?? null
    },
    preview: target.label,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Focus targets are runtime-only turn context.",
      ttlDays: null
    },
    sourceType: "system_prompt"
  }));
}

function toFilteredFragment(
  fragment: ContextFragment,
  activeTarget: FocusTarget | null
): ContextAssemblyDebugView["filteredOutFragments"][number] {
  return {
    filterReason:
      activeTarget === null ? "Filtered by focus scope" : `Filtered by focus scope: ${activeTarget.label}`,
    filterReasonCode: "filtered_by_scope",
    label: fragment.title,
    metadata: {
      confidence: Number(fragment.confidence.toFixed(2)),
      memoryId: fragment.memoryId,
      scope: fragment.scope,
      status: fragment.status
    },
    preview: sanitizePreview(fragment.text),
    privacyLevel: fragment.privacyLevel,
    retentionPolicy: fragment.retentionPolicy,
    sourceType: "filtered_out"
  };
}

function sanitizePreview(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 220 ? compact : `${compact.slice(0, 220)}...`;
}

function buildClarificationMessage(
  kind: FocusTargetKind,
  candidates: FocusTarget[],
  cwd: string
): string {
  const first = candidates[0];
  const second = candidates[1];
  if (first !== undefined && second !== undefined) {
    return `你是指 ${clarificationLabel(first, cwd)} 还是 ${clarificationLabel(second, cwd)}？`;
  }
  return genericClarificationMessage(kind);
}

function clarificationLabel(target: FocusTarget, cwd: string): string {
  if (target.kind === "file") {
    return displayPath(target.path ?? target.label, cwd);
  }
  if (target.kind === "url") {
    return target.url ?? target.label;
  }
  return target.path !== undefined
    ? `${target.symbolName ?? target.label} (${displayPath(target.path, cwd)})`
    : (target.symbolName ?? target.label);
}

function genericClarificationMessage(kind: FocusTargetKind): string {
  if (kind === "file") {
    return "你具体指哪个文件？";
  }
  if (kind === "function") {
    return "你具体指哪个函数？";
  }
  if (kind === "class") {
    return "你具体指哪个类？";
  }
  return "你具体指哪个链接？";
}

function isConflictingCandidate(candidate: ExtractedTarget, activeTarget: FocusTarget): boolean {
  if (candidate.kind !== activeTarget.kind) {
    return false;
  }
  if (candidate.kind === "file") {
    return candidate.path !== undefined && candidate.path !== activeTarget.path;
  }
  if (candidate.kind === "url") {
    return candidate.url !== undefined && normalizeUrl(candidate.url) !== activeTarget.url;
  }
  return candidate.symbolName !== undefined && candidate.symbolName !== activeTarget.symbolName;
}

function listCandidatesForKind(state: FocusState, kind: FocusTargetKind): FocusTarget[] {
  return state.recentTargets.filter((target) => target.kind === kind).sort((left, right) => right.score - left.score);
}

function normalizePath(pathValue: string, cwd: string): string {
  const raw = pathValue.trim();
  return normalize(isAbsolute(raw) ? raw : resolve(cwd || ".", raw));
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function displayPath(pathValue: string, cwd: string): string {
  const rel = relative(cwd || ".", pathValue);
  if (rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return rel.length === 0 ? basename(pathValue) : rel.replace(/\\/gu, "/");
  }
  return basename(pathValue);
}

function parseToolMessageOutput(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function parseFocusTarget(value: unknown): FocusTarget | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "file" && kind !== "function" && kind !== "class" && kind !== "url") {
    return null;
  }
  if (
    typeof record.id !== "string" ||
    typeof record.label !== "string" ||
    typeof record.lastTouchedAt !== "string" ||
    typeof record.score !== "number" ||
    typeof record.source !== "string" ||
    typeof record.taskId !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    kind,
    label: record.label,
    ...(typeof record.lineEnd === "number" ? { lineEnd: record.lineEnd } : {}),
    ...(typeof record.lineStart === "number" ? { lineStart: record.lineStart } : {}),
    lastTouchedAt: record.lastTouchedAt,
    ...(typeof record.occurrenceCount === "number" ? { occurrenceCount: record.occurrenceCount } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    score: record.score,
    source: record.source as FocusTargetSource,
    ...(typeof record.symbolName === "string" ? { symbolName: record.symbolName } : {}),
    taskId: record.taskId,
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    userTurnIndex: typeof record.userTurnIndex === "number" ? record.userTurnIndex : 0
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

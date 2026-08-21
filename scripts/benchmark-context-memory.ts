/**
 * Reproducible offline benchmarks for AutoTalon context governance and memory recall.
 *
 * A. Context governance — synthetic long-session token compression (offline).
 * B. Memory recall — ~40 labeled queries with hard negatives + baseline ablation.
 *
 * Run: node --disable-warning=ExperimentalWarning --import tsx scripts/benchmark-context-memory.ts
 * Optional: --json <path> to write the memory ablation report.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ContextCompactor } from "../src/runtime/context/context-compactor.js";
import { applyToolOutputBudget, DEFAULT_TOOL_OUTPUT_MAX_TOKENS } from "../src/runtime/context/tool-output-budget.js";
import { pruneOldToolResults, DEFAULT_TOOL_RESULT_KEEP_GROUPS } from "../src/runtime/context/tool-result-pruner.js";
import { estimateConversationMessageTokens } from "../src/runtime/context/token-counter.js";
import { RecallEngine, tokenize } from "../src/recall/recall-engine.js";
import { expandQueryTokens } from "../src/memory/memory-keywords.js";
import type { ConversationMessage, MemoryRecord, TaskRecord } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(2));
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

function makeTask(taskId: string, goal: string): TaskRecord {
  return {
    agentProfileId: "executor",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentIteration: 1,
    cwd: "/repo",
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: goal,
    maxIterations: 40,
    metadata: {},
    providerName: "mock",
    requesterUserId: "u1",
    startedAt: "2026-01-01T00:00:01.000Z",
    status: "running",
    taskId,
    sessionId: "session-1",
    tokenBudget: { inputLimit: 128000, outputLimit: 8000, reservedOutput: 4000, usedInput: 0, usedOutput: 0 },
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
}

// ---------------------------------------------------------------------------
// A. Context governance benchmark (kept as offline supporting signal)
// ---------------------------------------------------------------------------

interface SessionConfig {
  name: string;
  rounds: number;
  fileBytes: number;
  shellBytes: number;
  repeatedReads: number;
  protectLastN: number;
}

const SESSION_CONFIGS: SessionConfig[] = [
  { name: "small-refactor", rounds: 10, fileBytes: 3_500, shellBytes: 1_200, repeatedReads: 2, protectLastN: 6 },
  { name: "bugfix-trace", rounds: 14, fileBytes: 5_000, shellBytes: 2_000, repeatedReads: 3, protectLastN: 6 },
  { name: "feature-medium", rounds: 18, fileBytes: 6_500, shellBytes: 2_500, repeatedReads: 3, protectLastN: 8 },
  { name: "test-hunt", rounds: 16, fileBytes: 4_200, shellBytes: 4_500, repeatedReads: 4, protectLastN: 6 },
  { name: "config-migrate", rounds: 12, fileBytes: 8_000, shellBytes: 1_500, repeatedReads: 2, protectLastN: 6 },
  { name: "large-feature", rounds: 24, fileBytes: 7_500, shellBytes: 3_000, repeatedReads: 4, protectLastN: 8 },
  { name: "log-heavy", rounds: 20, fileBytes: 3_000, shellBytes: 9_000, repeatedReads: 2, protectLastN: 6 },
  { name: "multi-file-edit", rounds: 22, fileBytes: 6_000, shellBytes: 2_200, repeatedReads: 5, protectLastN: 8 },
  { name: "deep-debug", rounds: 28, fileBytes: 5_500, shellBytes: 5_000, repeatedReads: 4, protectLastN: 8 },
  { name: "doc-and-code", rounds: 15, fileBytes: 9_500, shellBytes: 1_800, repeatedReads: 3, protectLastN: 6 },
  { name: "wide-search", rounds: 19, fileBytes: 2_800, shellBytes: 7_000, repeatedReads: 3, protectLastN: 6 },
  { name: "long-haul", rounds: 32, fileBytes: 6_800, shellBytes: 4_000, repeatedReads: 6, protectLastN: 8 }
];

function fill(seed: string, bytes: number): string {
  const unit = `${seed} `;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function buildSession(config: SessionConfig): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  messages.push({
    role: "user",
    content:
      "Implement and verify the streaming compaction feature across the runtime, " +
      "keeping session continuity intact. Investigate failures and summarize."
  });

  const bigFile = fill("export function handleContextWindow(state){/* impl */}", config.fileBytes);
  for (let round = 0; round < config.rounds; round += 1) {
    const readsSameFile = round < config.repeatedReads;
    const filePayload = readsSameFile
      ? bigFile
      : fill(`module-${round} source line with logic and comments`, config.fileBytes);

    messages.push({
      role: "assistant",
      content: `Round ${round}: reading a file then running a command.`,
      toolCalls: [
        {
          toolCallId: `tc-read-${round}`,
          toolName: "read_file",
          input: { path: `src/mod-${readsSameFile ? "core" : round}.ts` },
          reason: "read source"
        },
        {
          toolCallId: `tc-sh-${round}`,
          toolName: "Shell",
          input: { command: "pnpm vitest run" },
          reason: "run tests"
        }
      ]
    });
    messages.push({
      role: "tool",
      toolCallId: `tc-read-${round}`,
      toolName: "read_file",
      content: JSON.stringify({ path: `src/mod-${readsSameFile ? "core" : round}.ts`, content: filePayload })
    });
    messages.push({
      role: "tool",
      toolCallId: `tc-sh-${round}`,
      toolName: "Shell",
      content: JSON.stringify({ stdout: fill(`test output round ${round}`, config.shellBytes), exitCode: 0 })
    });
  }
  messages.push({
    role: "assistant",
    content:
      "Decision: reuse the hybrid token counter.\nNext Actions:\n- run the smoke suite\n- update the changelog"
  });
  return messages;
}

function rawTokens(messages: ConversationMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateConversationMessageTokens(message), 0);
}

function runContextBenchmark(): { avgCompression: number; maxCompression: number; rows: string[] } {
  const compactor = new ContextCompactor();
  const artifactsRoot = join(tmpdir(), "auto-talon-benchmark-artifacts");
  const rows: string[] = [];
  const compressions: number[] = [];

  for (const config of SESSION_CONFIGS) {
    const messages = buildSession(config);
    const before = rawTokens(messages);

    const budgeted: ConversationMessage[] = messages.map((message) => {
      if (message.role !== "tool") {
        return message;
      }
      const result = applyToolOutputBudget(
        { serialized: message.content, taskId: "bench", toolCallId: message.toolCallId ?? "tc" },
        { artifactsRoot, maxTokensPerResult: DEFAULT_TOOL_OUTPUT_MAX_TOKENS }
      );
      return { ...message, content: result.content };
    });

    pruneOldToolResults(budgeted, DEFAULT_TOOL_RESULT_KEEP_GROUPS);

    const protectLastN = config.protectLastN;
    const head = budgeted.slice(0, Math.max(0, budgeted.length - protectLastN));
    const tail = budgeted.slice(Math.max(0, budgeted.length - protectLastN));
    const summary = compactor.buildSessionSummary({
      availableTools: [],
      compact: {
        maxMessagesBeforeCompact: 6,
        messages: head.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
          ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
          ...(m.toolCalls !== undefined
            ? { toolCalls: m.toolCalls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName })) }
            : {})
        })),
        reason: "context_budget",
        sessionScopeKey: "bench",
        taskId: "bench"
      },
      task: makeTask("bench", "streaming compaction feature")
    });

    const compacted: ConversationMessage[] = [{ role: "system", content: summary.summary }, ...tail];
    const after = rawTokens(compacted);
    const compression = pct(before - after, before);
    compressions.push(compression);
    rows.push(
      `${config.name.padEnd(16)} rounds=${String(config.rounds).padStart(2)}  ` +
        `before=${String(before).padStart(6)}  after=${String(after).padStart(5)}  ` +
        `compression=${compression.toFixed(2)}%`
    );
  }

  return {
    avgCompression: avg(compressions),
    maxCompression: Math.max(...compressions),
    rows
  };
}

// ---------------------------------------------------------------------------
// B. Memory recall with hard negatives + baseline ablation
// ---------------------------------------------------------------------------

function makeMemory(overrides: Partial<MemoryRecord> & { memoryId: string }): MemoryRecord {
  return {
    memoryId: overrides.memoryId,
    scope: overrides.scope ?? "project",
    scopeKey: overrides.scopeKey ?? "repo",
    title: overrides.title ?? "",
    content: overrides.content ?? "",
    summary: overrides.summary ?? "",
    source: overrides.source ?? {
      sourceType: "tool_output",
      taskId: "task-1",
      toolCallId: null,
      traceEventId: null,
      label: "Task"
    },
    sourceType: overrides.sourceType ?? "tool_output",
    privacyLevel: overrides.privacyLevel ?? "internal",
    retentionPolicy: overrides.retentionPolicy ?? { kind: "project", ttlDays: null, reason: "project knowledge" },
    confidence: overrides.confidence ?? 0.9,
    status: overrides.status ?? "verified",
    tier: overrides.tier ?? "retrieval",
    createdAt: overrides.createdAt ?? new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    lastVerifiedAt: overrides.lastVerifiedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    supersedes: overrides.supersedes ?? null,
    conflictsWith: overrides.conflictsWith ?? [],
    keywords: overrides.keywords ?? [],
    metadata: overrides.metadata ?? {}
  };
}

interface RecallCase {
  id: string;
  query: string;
  relevantIds: Set<string>;
  hardNegativeIds: Set<string>;
  memories: MemoryRecord[];
}

function caseOf(input: {
  id: string;
  query: string;
  good: MemoryRecord;
  hard: MemoryRecord;
  noise?: MemoryRecord[];
  extraHard?: MemoryRecord[];
}): RecallCase {
  const noise = input.noise ?? [];
  const extraHard = input.extraHard ?? [];
  // Hard negatives first so equal-score baselines prefer them (stable sort).
  return {
    id: input.id,
    query: input.query,
    relevantIds: new Set([input.good.memoryId]),
    hardNegativeIds: new Set([input.hard.memoryId, ...extraHard.map((m) => m.memoryId)]),
    memories: [input.hard, ...extraHard, input.good, ...noise]
  };
}

function noiseStale(id: string, shared: { title: string; summary: string; content: string; keywords: string[] }): MemoryRecord {
  return makeMemory({
    memoryId: id,
    title: shared.title,
    summary: shared.summary,
    content: shared.content,
    keywords: shared.keywords,
    status: "stale",
    confidence: 0.65
  });
}

function noiseRejected(id: string, shared: { title: string; summary: string; content: string; keywords: string[] }): MemoryRecord {
  return makeMemory({
    memoryId: id,
    title: shared.title,
    summary: shared.summary,
    content: shared.content,
    keywords: shared.keywords,
    status: "rejected",
    confidence: 0.9
  });
}

function noiseLowConf(id: string, shared: { title: string; summary: string; content: string; keywords: string[] }): MemoryRecord {
  return makeMemory({
    memoryId: id,
    title: shared.title,
    summary: shared.summary,
    content: shared.content,
    keywords: shared.keywords,
    confidence: 0.5
  });
}

/**
 * ~40 labeled cases. Hard negatives share keywords/paths but teach the wrong conclusion.
 * Keyword-only rankers should be fooled; full-signal ranking should prefer verified good memories.
 * `hardenCases` further stuffs hard-negative keywords and trims good-memory keywords.
 */
function buildRecallCases(): RecallCase[] {
  return [
    caseOf({
      id: "sqlite_busy",
      query: "debug SQLITE_BUSY during migration in src/storage/migrations.ts",
      good: makeMemory({
        memoryId: "m-sqlite-good",
        title: "SQLite migration busy fix",
        summary: "Serialize writes to avoid SQLITE_BUSY in src/storage/migrations.ts",
        content: "Wrap migration in a single transaction; SQLITE_BUSY resolved in src/storage/migrations.ts.",
        keywords: ["sqlite", "migration", "sqlite_busy", "src/storage/migrations.ts"]
      }),
      hard: makeMemory({
        memoryId: "m-sqlite-hard",
        title: "SQLite migration busy wrong advice",
        summary: "Delete the database file when SQLITE_BUSY appears in src/storage/migrations.ts",
        content: "Wrong: deleting the DB on SQLITE_BUSY during migration in src/storage/migrations.ts.",
        keywords: ["sqlite", "migration", "sqlite_busy", "src/storage/migrations.ts"]
      }),
      noise: [
        noiseStale("m-sqlite-stale", {
          title: "SQLite migration busy (old)",
          summary: "Old SQLITE_BUSY note for src/storage/migrations.ts",
          content: "outdated sqlite migration busy advice",
          keywords: ["sqlite", "migration", "sqlite_busy", "src/storage/migrations.ts"]
        })
      ]
    }),
    caseOf({
      id: "provider_base_url",
      query: "how to configure the provider base-url for deepseek openai-compatible endpoint",
      good: makeMemory({
        memoryId: "m-provider-good",
        title: "DeepSeek provider setup",
        summary: "Use openai-compatible transport with base-url and model for deepseek",
        content: "provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat",
        keywords: ["provider", "base-url", "deepseek", "openai-compatible", "model"]
      }),
      hard: makeMemory({
        memoryId: "m-provider-hard",
        title: "DeepSeek provider wrong setup",
        summary: "Point deepseek openai-compatible base-url at localhost without a model",
        content: "Wrong: provider setup deepseek openai-compatible base-url http://127.0.0.1 without model",
        keywords: ["provider", "base-url", "deepseek", "openai-compatible", "model"]
      }),
      noise: [
        noiseRejected("m-provider-rejected", {
          title: "Rejected provider note",
          summary: "Rejected deepseek openai-compatible base-url advice",
          content: "do not follow rejected deepseek provider base-url note",
          keywords: ["provider", "base-url", "deepseek", "openai-compatible"]
        })
      ]
    }),
    caseOf({
      id: "ci_coverage",
      query: "fix failing vitest coverage gate in CI build",
      good: makeMemory({
        memoryId: "m-ci-good",
        title: "Coverage gate fix",
        summary: "Raise vitest coverage thresholds and exclude generated files in CI",
        content: "vitest coverage gate failed in CI build; fixed by adjusting thresholds and excludes",
        keywords: ["vitest", "coverage", "ci", "build", "gate"]
      }),
      hard: makeMemory({
        memoryId: "m-ci-hard",
        title: "Coverage gate wrong fix",
        summary: "Disable the vitest coverage gate entirely in CI build",
        content: "Wrong: remove vitest coverage gate from CI build to make it green",
        keywords: ["vitest", "coverage", "ci", "build", "gate"]
      }),
      noise: [
        noiseLowConf("m-ci-lowconf", {
          title: "Coverage guess",
          summary: "Maybe vitest coverage ci build gate related",
          content: "uncertain low confidence coverage ci build note",
          keywords: ["vitest", "coverage", "ci", "build", "gate"]
        })
      ]
    }),
    caseOf({
      id: "approval_fingerprint",
      query: "approval fingerprint scope for high-risk shell tool calls",
      good: makeMemory({
        memoryId: "m-approval-good",
        title: "Approval fingerprint scoping",
        summary: "Persist allow rules keyed by approval fingerprint for shell tool",
        content: "high-risk shell approval fingerprint scope persisted allow rule",
        keywords: ["approval", "fingerprint", "shell", "allow", "scope"]
      }),
      hard: makeMemory({
        memoryId: "m-approval-hard",
        title: "Approval fingerprint wrong scope",
        summary: "Globally allow all shell tool calls without approval fingerprint",
        content: "Wrong: skip approval fingerprint and allow every shell tool call",
        keywords: ["approval", "fingerprint", "shell", "allow", "scope"]
      })
    }),
    caseOf({
      id: "resume_packet",
      query: "session resume packet after task interruption in continue command",
      good: makeMemory({
        memoryId: "m-resume-good",
        title: "Resume packet build",
        summary: "continue command rebuilds resume packet from last session summary",
        content: "task interruption resume packet continue command session",
        keywords: ["resume", "packet", "continue", "session", "interruption"]
      }),
      hard: makeMemory({
        memoryId: "m-resume-hard",
        title: "Resume packet wrong advice",
        summary: "continue command should discard resume packet after interruption",
        content: "Wrong: delete resume packet and start continue session from empty state",
        keywords: ["resume", "packet", "continue", "session", "interruption"]
      }),
      noise: [
        noiseStale("m-resume-stale", {
          title: "Old resume note",
          summary: "stale resume packet continue session note",
          content: "outdated resume packet continue session interruption",
          keywords: ["resume", "packet", "continue", "session", "interruption"]
        })
      ]
    }),
    caseOf({
      id: "cron_nl",
      query: "cron schedule natural language parsing every 1d for daily review",
      good: makeMemory({
        memoryId: "m-cron-good",
        title: "Natural language schedule",
        summary: "Parse 'every 1d' into cron for daily review schedule",
        content: "cron schedule natural language every 1d daily review parse",
        keywords: ["cron", "schedule", "natural", "every", "daily"]
      }),
      hard: makeMemory({
        memoryId: "m-cron-hard",
        title: "Natural language schedule wrong",
        summary: "Treat every 1d as every 1 hour for daily review cron schedule",
        content: "Wrong: map natural language every 1d to hourly cron for daily review",
        keywords: ["cron", "schedule", "natural", "every", "daily"]
      })
    }),
    caseOf({
      id: "mcp_stdio_env",
      query: "mcp stdio client environment variables not passed to server",
      good: makeMemory({
        memoryId: "m-mcp-good",
        title: "MCP stdio env fix",
        summary: "Forward process env to MCP stdio server on spawn",
        content: "mcp stdio client environment variables server spawn env",
        keywords: ["mcp", "stdio", "environment", "server", "env"]
      }),
      hard: makeMemory({
        memoryId: "m-mcp-hard",
        title: "MCP stdio env wrong",
        summary: "Strip all environment variables when spawning MCP stdio server",
        content: "Wrong: clear env for mcp stdio client server spawn",
        keywords: ["mcp", "stdio", "environment", "server", "env"]
      }),
      noise: [
        noiseLowConf("m-mcp-lowconf", {
          title: "MCP env guess",
          summary: "maybe mcp stdio env server related low confidence",
          content: "uncertain mcp stdio environment server note",
          keywords: ["mcp", "stdio", "environment", "server", "env"]
        })
      ]
    }),
    caseOf({
      id: "sandbox_boundary",
      query: "sandbox policy blocks file write outside workspace boundary",
      good: makeMemory({
        memoryId: "m-sandbox-good",
        title: "Sandbox workspace boundary",
        summary: "File writes outside workspace boundary are blocked by sandbox policy",
        content: "sandbox policy file write workspace boundary blocked scope",
        keywords: ["sandbox", "policy", "workspace", "boundary", "write"]
      }),
      hard: makeMemory({
        memoryId: "m-sandbox-hard",
        title: "Sandbox boundary wrong",
        summary: "Allow sandbox policy to write files outside workspace boundary",
        content: "Wrong: disable sandbox policy workspace boundary for file write",
        keywords: ["sandbox", "policy", "workspace", "boundary", "write"]
      })
    }),
    caseOf({
      id: "token_cjk",
      query: "token counter cjk multiplier estimate for chinese prompt",
      good: makeMemory({
        memoryId: "m-token-good",
        title: "CJK token estimate",
        summary: "Apply cjk multiplier in token counter for chinese prompt",
        content: "token counter cjk multiplier estimate chinese prompt padding",
        keywords: ["token", "counter", "cjk", "estimate", "chinese"]
      }),
      hard: makeMemory({
        memoryId: "m-token-hard",
        title: "CJK token wrong",
        summary: "Ignore cjk multiplier and treat chinese prompt like ascii in token counter",
        content: "Wrong: disable cjk multiplier estimate for chinese prompt token counter",
        keywords: ["token", "counter", "cjk", "estimate", "chinese"]
      })
    }),
    caseOf({
      id: "feishu_gateway",
      query: "feishu gateway adapter shares runtime session governance",
      good: makeMemory({
        memoryId: "m-feishu-good",
        title: "Feishu gateway governance",
        summary: "Feishu adapter enters through gateway sharing runtime governance",
        content: "feishu gateway adapter runtime session governance policy",
        keywords: ["feishu", "gateway", "adapter", "runtime", "governance"]
      }),
      hard: makeMemory({
        memoryId: "m-feishu-hard",
        title: "Feishu gateway bypass wrong",
        summary: "Feishu gateway adapter should bypass runtime session governance",
        content: "Wrong: feishu gateway adapter bypasses runtime governance policy",
        keywords: ["feishu", "gateway", "adapter", "runtime", "governance"]
      }),
      noise: [
        noiseRejected("m-feishu-rejected", {
          title: "Bad feishu note",
          summary: "rejected feishu gateway bypass governance note",
          content: "do not use feishu gateway bypass runtime governance",
          keywords: ["feishu", "gateway", "adapter", "runtime", "governance"]
        })
      ]
    }),
    caseOf({
      id: "skill_promotion",
      query: "skill registry promotion advisor suggests promoting draft skill",
      good: makeMemory({
        memoryId: "m-skill-good",
        title: "Skill promotion advisor",
        summary: "Promotion advisor suggests promoting draft skill after stable success",
        content: "skill registry promotion advisor draft skill promote when stable",
        keywords: ["skill", "registry", "promotion", "advisor", "draft"]
      }),
      hard: makeMemory({
        memoryId: "m-skill-hard",
        title: "Skill promotion wrong",
        summary: "Always promote draft skill immediately without advisor checks",
        content: "Wrong: skill registry promotion advisor auto-promotes every draft skill",
        keywords: ["skill", "registry", "promotion", "advisor", "draft"]
      })
    }),
    caseOf({
      id: "audit_rollback",
      query: "audit log and rollback snapshot after risky file write",
      good: makeMemory({
        memoryId: "m-audit-good",
        title: "Audit and rollback",
        summary: "Risky file write records audit log and creates rollback snapshot",
        content: "audit log rollback snapshot risky file write governance",
        keywords: ["audit", "log", "rollback", "snapshot", "write"]
      }),
      hard: makeMemory({
        memoryId: "m-audit-hard",
        title: "Audit rollback wrong",
        summary: "Skip audit log and rollback snapshot for risky file write",
        content: "Wrong: disable audit log rollback snapshot after risky file write",
        keywords: ["audit", "log", "rollback", "snapshot", "write"]
      })
    }),
    caseOf({
      id: "schedule_inbox",
      query: "schedule delivery writes inbox item when webhook unavailable",
      good: makeMemory({
        memoryId: "m-schedule-good",
        title: "Schedule inbox fallback",
        summary: "When webhook unavailable, schedule delivery writes an inbox item",
        content: "schedule delivery inbox item webhook unavailable fallback",
        keywords: ["schedule", "delivery", "inbox", "webhook", "unavailable"]
      }),
      hard: makeMemory({
        memoryId: "m-schedule-hard",
        title: "Schedule inbox wrong",
        summary: "Drop schedule delivery silently when webhook unavailable",
        content: "Wrong: skip inbox item when schedule delivery webhook unavailable",
        keywords: ["schedule", "delivery", "inbox", "webhook", "unavailable"]
      })
    }),
    caseOf({
      id: "context_assembler",
      query: "context assembler injects recalled memory fragments with explanation",
      good: makeMemory({
        memoryId: "m-assembler-good",
        title: "Context assembler recall",
        summary: "Context assembler injects recalled memory fragments with source explanation",
        content: "context assembler inject recalled memory fragments explanation",
        keywords: ["context", "assembler", "recalled", "memory", "explanation"]
      }),
      hard: makeMemory({
        memoryId: "m-assembler-hard",
        title: "Context assembler wrong",
        summary: "Context assembler injects recalled memory fragments without explanation",
        content: "Wrong: hide explanation when assembling recalled memory fragments",
        keywords: ["context", "assembler", "recalled", "memory", "explanation"]
      })
    }),
    caseOf({
      id: "tool_output_budget",
      query: "tool output budget spills oversized shell result to artifact path",
      good: makeMemory({
        memoryId: "m-budget-good",
        title: "Tool output spill",
        summary: "Oversized shell tool output spills to artifact path under tool output budget",
        content: "tool output budget spill oversized shell result artifact path",
        keywords: ["tool", "output", "budget", "spill", "artifact", "shell"]
      }),
      hard: makeMemory({
        memoryId: "m-budget-hard",
        title: "Tool output spill wrong",
        summary: "Keep full oversized shell tool output inline and ignore artifact spill",
        content: "Wrong: disable tool output budget spill for oversized shell artifact",
        keywords: ["tool", "output", "budget", "spill", "artifact", "shell"]
      })
    }),
    caseOf({
      id: "reactive_compact",
      query: "reactive compact drops oldest messages on provider context overflow",
      good: makeMemory({
        memoryId: "m-reactive-good",
        title: "Reactive compact overflow",
        summary: "On provider context overflow, reactive compact drops oldest non-system messages",
        content: "reactive compact drops oldest messages provider context overflow",
        keywords: ["reactive", "compact", "overflow", "provider", "messages"]
      }),
      hard: makeMemory({
        memoryId: "m-reactive-hard",
        title: "Reactive compact wrong",
        summary: "On provider context overflow, delete the latest user message first",
        content: "Wrong: reactive compact should drop latest user message on overflow",
        keywords: ["reactive", "compact", "overflow", "provider", "messages"]
      })
    }),
    caseOf({
      id: "session_lineage",
      query: "session lineage tracks parent child tasks for continue resume",
      good: makeMemory({
        memoryId: "m-lineage-good",
        title: "Session lineage",
        summary: "Session lineage tracks parent/child tasks for continue and resume",
        content: "session lineage parent child tasks continue resume tracking",
        keywords: ["session", "lineage", "parent", "child", "continue", "resume"]
      }),
      hard: makeMemory({
        memoryId: "m-lineage-hard",
        title: "Session lineage wrong",
        summary: "Skip session lineage so continue resume cannot find parent child tasks",
        content: "Wrong: disable session lineage tracking for continue resume parent child",
        keywords: ["session", "lineage", "parent", "child", "continue", "resume"]
      })
    }),
    caseOf({
      id: "doctor_fix",
      query: "talon doctor --fix migrates legacy thread schema to session",
      good: makeMemory({
        memoryId: "m-doctor-good",
        title: "Doctor schema migration",
        summary: "talon doctor --fix migrates legacy thread schema to session",
        content: "doctor --fix migrates legacy thread schema session upgrade",
        keywords: ["doctor", "fix", "legacy", "thread", "session", "schema"]
      }),
      hard: makeMemory({
        memoryId: "m-doctor-hard",
        title: "Doctor schema wrong",
        summary: "talon doctor --fix deletes legacy thread data instead of migrating",
        content: "Wrong: doctor --fix should wipe legacy thread schema without session migrate",
        keywords: ["doctor", "fix", "legacy", "thread", "session", "schema"]
      })
    }),
    caseOf({
      id: "delegate_isolation",
      query: "delegate task tool isolates child workspace from parent session",
      good: makeMemory({
        memoryId: "m-delegate-good",
        title: "Delegate isolation",
        summary: "delegate task tool isolates child workspace from parent session state",
        content: "delegate task tool isolation child workspace parent session",
        keywords: ["delegate", "task", "tool", "isolation", "workspace", "session"]
      }),
      hard: makeMemory({
        memoryId: "m-delegate-hard",
        title: "Delegate isolation wrong",
        summary: "delegate task tool shares mutable parent session state with child workspace",
        content: "Wrong: disable isolation so delegate task tool mutates parent session",
        keywords: ["delegate", "task", "tool", "isolation", "workspace", "session"]
      })
    }),
    caseOf({
      id: "provider_failover",
      query: "provider failover switches to backup when primary returns timeout",
      good: makeMemory({
        memoryId: "m-failover-good",
        title: "Provider failover",
        summary: "Provider failover switches to backup when primary returns timeout",
        content: "provider failover backup primary timeout switch",
        keywords: ["provider", "failover", "backup", "timeout", "primary"]
      }),
      hard: makeMemory({
        memoryId: "m-failover-hard",
        title: "Provider failover wrong",
        summary: "Abort the whole task on primary timeout without provider failover",
        content: "Wrong: skip provider failover backup when primary timeout occurs",
        keywords: ["provider", "failover", "backup", "timeout", "primary"]
      })
    }),
    caseOf({
      id: "memory_flush",
      query: "memory flush writes working memory before session compact handoff",
      good: makeMemory({
        memoryId: "m-flush-good",
        title: "Memory flush before compact",
        summary: "Memory flush writes working memory before session compact handoff",
        content: "memory flush working memory before session compact handoff",
        keywords: ["memory", "flush", "working", "compact", "handoff", "session"]
      }),
      hard: makeMemory({
        memoryId: "m-flush-hard",
        title: "Memory flush wrong",
        summary: "Skip memory flush of working memory before session compact handoff",
        content: "Wrong: compact handoff without memory flush of working memory",
        keywords: ["memory", "flush", "working", "compact", "handoff", "session"]
      })
    }),
    caseOf({
      id: "patch_tool",
      query: "patch tool applies unified diff only inside sandbox write roots",
      good: makeMemory({
        memoryId: "m-patch-good",
        title: "Patch tool sandbox",
        summary: "patch tool applies unified diff only inside sandbox write roots",
        content: "patch tool unified diff sandbox write roots restricted",
        keywords: ["patch", "tool", "diff", "sandbox", "write", "roots"]
      }),
      hard: makeMemory({
        memoryId: "m-patch-hard",
        title: "Patch tool wrong",
        summary: "patch tool may apply unified diff outside sandbox write roots",
        content: "Wrong: allow patch tool diff outside sandbox write roots",
        keywords: ["patch", "tool", "diff", "sandbox", "write", "roots"]
      })
    }),
    caseOf({
      id: "webhook_rate_limit",
      query: "gateway rate limit rejects burst webhook deliveries",
      good: makeMemory({
        memoryId: "m-webhook-good",
        title: "Gateway rate limit",
        summary: "Gateway rate limit rejects burst webhook deliveries",
        content: "gateway rate limit rejects burst webhook delivery requests",
        keywords: ["gateway", "rate", "limit", "webhook", "burst"]
      }),
      hard: makeMemory({
        memoryId: "m-webhook-hard",
        title: "Gateway rate limit wrong",
        summary: "Disable gateway rate limit so burst webhook deliveries always succeed",
        content: "Wrong: remove gateway rate limit for burst webhook deliveries",
        keywords: ["gateway", "rate", "limit", "webhook", "burst"]
      })
    }),
    caseOf({
      id: "todo_panel",
      query: "session todos re-injected into context after compact",
      good: makeMemory({
        memoryId: "m-todo-good",
        title: "Todos reinjection",
        summary: "Session todos are re-injected into context after compact",
        content: "session todos reinjected context after compact handoff",
        keywords: ["session", "todos", "context", "compact", "reinject"]
      }),
      hard: makeMemory({
        memoryId: "m-todo-hard",
        title: "Todos reinjection wrong",
        summary: "Drop session todos from context permanently after compact",
        content: "Wrong: do not reinject session todos after compact context",
        keywords: ["session", "todos", "context", "compact", "reinject"]
      })
    }),
    caseOf({
      id: "blind_eval",
      query: "blind eval suite hides task ids and scorer definitions from the model",
      good: makeMemory({
        memoryId: "m-eval-good",
        title: "Blind eval isolation",
        summary: "Blind eval suite hides task ids and scorer definitions from the model",
        content: "blind eval suite hides task ids scorer definitions model isolation",
        keywords: ["blind", "eval", "suite", "scorer", "task", "model"]
      }),
      hard: makeMemory({
        memoryId: "m-eval-hard",
        title: "Blind eval wrong",
        summary: "Expose task ids and scorer definitions to the model in blind eval",
        content: "Wrong: leak blind eval task ids and scorer definitions to the model",
        keywords: ["blind", "eval", "suite", "scorer", "task", "model"]
      })
    }),
    caseOf({
      id: "allow_rules",
      query: "persisted allow rules reuse approval fingerprint across sessions",
      good: makeMemory({
        memoryId: "m-allow-good",
        title: "Persisted allow rules",
        summary: "Persisted allow rules reuse approval fingerprint across sessions",
        content: "persisted allow rules approval fingerprint reuse across sessions",
        keywords: ["allow", "rules", "approval", "fingerprint", "sessions"]
      }),
      hard: makeMemory({
        memoryId: "m-allow-hard",
        title: "Persisted allow rules wrong",
        summary: "Persisted allow rules ignore approval fingerprint and auto-allow everything",
        content: "Wrong: persisted allow rules without approval fingerprint across sessions",
        keywords: ["allow", "rules", "approval", "fingerprint", "sessions"]
      })
    }),
    caseOf({
      id: "profile_memory",
      query: "profile memory stores durable user preferences across projects",
      good: makeMemory({
        memoryId: "m-profile-good",
        title: "Profile memory",
        summary: "Profile memory stores durable user preferences across projects",
        content: "profile memory durable user preferences across projects scope",
        keywords: ["profile", "memory", "preferences", "projects", "durable"],
        scope: "profile"
      }),
      hard: makeMemory({
        memoryId: "m-profile-hard",
        title: "Profile memory wrong",
        summary: "Store ephemeral working notes as profile memory across projects",
        content: "Wrong: put ephemeral working notes into profile memory across projects",
        keywords: ["profile", "memory", "preferences", "projects", "durable"],
        scope: "profile"
      })
    }),
    caseOf({
      id: "working_memory_ttl",
      query: "working memory expires with retention ttl and should not be recalled stale",
      good: makeMemory({
        memoryId: "m-working-good",
        title: "Working memory TTL",
        summary: "Working memory expires with retention ttl and is excluded when stale",
        content: "working memory retention ttl expires stale recall excluded",
        keywords: ["working", "memory", "ttl", "retention", "stale"],
        scope: "working"
      }),
      hard: makeMemory({
        memoryId: "m-working-hard",
        title: "Working memory TTL wrong",
        summary: "Keep expired working memory forever ignoring retention ttl",
        content: "Wrong: ignore retention ttl and recall expired working memory stale",
        keywords: ["working", "memory", "ttl", "retention", "stale"],
        scope: "working"
      })
    }),
    caseOf({
      id: "cost_calculator",
      query: "cost calculator uses provider pricing for input and output tokens",
      good: makeMemory({
        memoryId: "m-cost-good",
        title: "Cost calculator pricing",
        summary: "Cost calculator uses provider pricing for input and output tokens",
        content: "cost calculator provider pricing input output tokens",
        keywords: ["cost", "calculator", "pricing", "input", "output", "tokens"]
      }),
      hard: makeMemory({
        memoryId: "m-cost-hard",
        title: "Cost calculator wrong",
        summary: "Cost calculator ignores provider pricing and always reports zero",
        content: "Wrong: cost calculator skips pricing for input output tokens",
        keywords: ["cost", "calculator", "pricing", "input", "output", "tokens"]
      })
    }),
    caseOf({
      id: "interaction_mode",
      query: "interaction mode acceptEdits auto-allows low-risk file edits",
      good: makeMemory({
        memoryId: "m-mode-good",
        title: "acceptEdits mode",
        summary: "interaction mode acceptEdits auto-allows low-risk file edits",
        content: "interaction mode acceptEdits auto allow low-risk file edits",
        keywords: ["interaction", "mode", "acceptedits", "file", "edits"]
      }),
      hard: makeMemory({
        memoryId: "m-mode-hard",
        title: "acceptEdits mode wrong",
        summary: "acceptEdits mode auto-allows high-risk shell without approval",
        content: "Wrong: interaction mode acceptEdits should auto-allow high-risk shell",
        keywords: ["interaction", "mode", "acceptedits", "file", "edits"]
      })
    }),
    caseOf({
      id: "experience_promotion",
      query: "experience collector promotes accepted lessons into project memory",
      good: makeMemory({
        memoryId: "m-experience-good",
        title: "Experience promotion",
        summary: "Experience collector promotes accepted lessons into project memory",
        content: "experience collector promotes accepted lessons project memory",
        keywords: ["experience", "collector", "promotes", "accepted", "project", "memory"]
      }),
      hard: makeMemory({
        memoryId: "m-experience-hard",
        title: "Experience promotion wrong",
        summary: "Promote rejected experiences straight into project memory",
        content: "Wrong: experience collector promotes rejected lessons into project memory",
        keywords: ["experience", "collector", "promotes", "accepted", "project", "memory"]
      })
    }),
    caseOf({
      id: "trace_summary",
      query: "talon trace --summary shows tool calls approvals and compact events",
      good: makeMemory({
        memoryId: "m-trace-good",
        title: "Trace summary",
        summary: "talon trace --summary shows tool calls, approvals, and compact events",
        content: "trace summary tool calls approvals compact events",
        keywords: ["trace", "summary", "tool", "approvals", "compact"]
      }),
      hard: makeMemory({
        memoryId: "m-trace-hard",
        title: "Trace summary wrong",
        summary: "talon trace --summary should hide approvals and compact events",
        content: "Wrong: omit approvals and compact events from trace summary",
        keywords: ["trace", "summary", "tool", "approvals", "compact"]
      })
    }),
    caseOf({
      id: "ollama_local",
      query: "ollama local provider setup without api key for offline runs",
      good: makeMemory({
        memoryId: "m-ollama-good",
        title: "Ollama local setup",
        summary: "ollama local provider setup works without api key for offline runs",
        content: "ollama local provider setup without api key offline runs",
        keywords: ["ollama", "local", "provider", "api", "key", "offline"]
      }),
      hard: makeMemory({
        memoryId: "m-ollama-hard",
        title: "Ollama local wrong",
        summary: "Require a cloud api key even for ollama local offline provider setup",
        content: "Wrong: force api key for ollama local provider offline runs",
        keywords: ["ollama", "local", "provider", "api", "key", "offline"]
      })
    }),
    caseOf({
      id: "commitment_next",
      query: "commitment collector extracts next actions into next-action store",
      good: makeMemory({
        memoryId: "m-commit-good",
        title: "Commitment next actions",
        summary: "Commitment collector extracts next actions into next-action store",
        content: "commitment collector extracts next actions next-action store",
        keywords: ["commitment", "collector", "next", "actions", "store"]
      }),
      hard: makeMemory({
        memoryId: "m-commit-hard",
        title: "Commitment next wrong",
        summary: "Ignore next actions and never write the next-action store",
        content: "Wrong: skip commitment collector next actions store writes",
        keywords: ["commitment", "collector", "next", "actions", "store"]
      })
    }),
    caseOf({
      id: "sqlite_fts",
      query: "sqlite fts index powers memory keyword search across scopes",
      good: makeMemory({
        memoryId: "m-fts-good",
        title: "SQLite FTS memory search",
        summary: "sqlite fts index powers memory keyword search across scopes",
        content: "sqlite fts index memory keyword search across profile project working",
        keywords: ["sqlite", "fts", "index", "memory", "keyword", "search"]
      }),
      hard: makeMemory({
        memoryId: "m-fts-hard",
        title: "SQLite FTS wrong",
        summary: "Disable sqlite fts and scan all memory rows without keyword index",
        content: "Wrong: drop sqlite fts index for memory keyword search",
        keywords: ["sqlite", "fts", "index", "memory", "keyword", "search"]
      })
    }),
    caseOf({
      id: "manual_compact",
      query: "manual compact coordinator queues focus topic for next loop iteration",
      good: makeMemory({
        memoryId: "m-manual-good",
        title: "Manual compact queue",
        summary: "Manual compact coordinator queues focus topic for next loop iteration",
        content: "manual compact coordinator queues focus topic next iteration",
        keywords: ["manual", "compact", "coordinator", "focus", "topic"]
      }),
      hard: makeMemory({
        memoryId: "m-manual-hard",
        title: "Manual compact wrong",
        summary: "Manual compact should ignore focus topic and compact immediately mid-tool-call",
        content: "Wrong: ignore coordinator focus topic and compact during unsafe tool calls",
        keywords: ["manual", "compact", "coordinator", "focus", "topic"]
      })
    }),
    caseOf({
      id: "workspace_map",
      query: "workspace map command lists key directories without reading every file",
      good: makeMemory({
        memoryId: "m-map-good",
        title: "Workspace map",
        summary: "workspace map command lists key directories without reading every file",
        content: "workspace map lists key directories without reading every file",
        keywords: ["workspace", "map", "directories", "files", "command"]
      }),
      hard: makeMemory({
        memoryId: "m-map-hard",
        title: "Workspace map wrong",
        summary: "workspace map should recursively read every file into context",
        content: "Wrong: workspace map reads every file into context instead of directories",
        keywords: ["workspace", "map", "directories", "files", "command"]
      })
    }),
    caseOf({
      id: "baseline_gate",
      query: "eval baseline gate blocks success-rate regression greater than five points",
      good: makeMemory({
        memoryId: "m-baseline-good",
        title: "Eval baseline gate",
        summary: "Eval baseline gate blocks success-rate regression greater than five points",
        content: "eval baseline gate blocks success-rate regression greater than 5pp",
        keywords: ["eval", "baseline", "gate", "success-rate", "regression"]
      }),
      hard: makeMemory({
        memoryId: "m-baseline-hard",
        title: "Eval baseline gate wrong",
        summary: "Ignore success-rate regression and never block on baseline gate",
        content: "Wrong: disable eval baseline gate for success-rate regression",
        keywords: ["eval", "baseline", "gate", "success-rate", "regression"]
      })
    }),
    caseOf({
      id: "path_escape",
      query: "path escape interception blocks ../ writes outside project root",
      good: makeMemory({
        memoryId: "m-escape-good",
        title: "Path escape interception",
        summary: "Path escape interception blocks ../ writes outside project root",
        content: "path escape interception blocks ../ writes outside project root",
        keywords: ["path", "escape", "interception", "writes", "project", "root"]
      }),
      hard: makeMemory({
        memoryId: "m-escape-hard",
        title: "Path escape wrong",
        summary: "Allow ../ writes outside project root without path escape interception",
        content: "Wrong: disable path escape interception for ../ writes outside root",
        keywords: ["path", "escape", "interception", "writes", "project", "root"]
      })
    }),
    caseOf({
      id: "hermes_threshold",
      query: "hermes compact threshold uses context window times ratio minus safety margin",
      good: makeMemory({
        memoryId: "m-hermes-good",
        title: "Hermes compact threshold",
        summary: "Hermes compact threshold uses context window times ratio minus safety margin",
        content: "hermes compact threshold context window ratio safety margin",
        keywords: ["hermes", "compact", "threshold", "context", "window", "ratio"]
      }),
      hard: makeMemory({
        memoryId: "m-hermes-hard",
        title: "Hermes compact wrong",
        summary: "Hermes compact threshold should ignore safety margin and fire at 100% window",
        content: "Wrong: hermes compact threshold without safety margin at full context window",
        keywords: ["hermes", "compact", "threshold", "context", "window", "ratio"]
      })
    })
  ];
}

type RankerName = "full_signal" | "baseline_keyword" | "baseline_keyword_substring";

interface RankedItem {
  memoryId: string;
  score: number;
}

/** Query coverage: |keywords ∩ queryTokens| / |queryTokens| (avoids overlapRatio ties). */
function keywordQueryCoverage(keywords: string[], queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const keywordSet = new Set(keywords.map((token) => token.toLowerCase()));
  const matched = queryTokens.filter((token) => keywordSet.has(token.toLowerCase())).length;
  return matched / queryTokens.length;
}

function contentSubstringHitRatio(memory: MemoryRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const text = `${memory.title} ${memory.summary} ${memory.content}`.toLowerCase();
  const hits = queryTokens.filter((token) => token.length >= 2 && text.includes(token.toLowerCase())).length;
  return hits / queryTokens.length;
}

function rankBaselineKeyword(memories: MemoryRecord[], query: string, limit: number): RankedItem[] {
  const queryTokens = tokenize(query);
  return memories
    .map((memory) => ({
      memoryId: memory.memoryId,
      score: keywordQueryCoverage(memory.keywords, queryTokens)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function rankBaselineKeywordSubstring(memories: MemoryRecord[], query: string, limit: number): RankedItem[] {
  const queryTokens = expandQueryTokens(query);
  return memories
    .map((memory) => ({
      memoryId: memory.memoryId,
      score: Math.max(
        keywordQueryCoverage(memory.keywords, queryTokens),
        contentSubstringHitRatio(memory, queryTokens)
      )
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function rankFullSignal(engine: RecallEngine, memories: MemoryRecord[], query: string, limit: number): RankedItem[] {
  return engine.rankMemory(memories, query, limit).map((candidate) => ({
    memoryId: candidate.memory.memoryId,
    score: candidate.finalScore
  }));
}

/**
 * Strengthen ablation: good memories keep tight keywords + high confidence;
 * hard negatives get query-token keyword stuffing + lower confidence, listed first.
 */
function hardenCases(cases: RecallCase[]): RecallCase[] {
  return cases.map((testCase) => {
    // Stuff with expanded tokens so both keyword and keyword+substring baselines prefer hard negatives.
    const queryTokens = expandQueryTokens(testCase.query);
    const baseTokens = tokenize(testCase.query);
    const stuffTokens = [...new Set([...queryTokens, ...baseTokens])];
    const pathTokens = stuffTokens.filter(
      (token) => token.includes("/") || token.includes("\\") || token.includes(".")
    );
    const memories = testCase.memories.map((memory) => {
      if (testCase.relevantIds.has(memory.memoryId)) {
        const coreKeywords = memory.keywords.slice(0, Math.min(3, memory.keywords.length));
        const needsPath =
          pathTokens.length > 0 &&
          !pathTokens.every((token) =>
            `${memory.title} ${memory.summary} ${memory.content}`.toLowerCase().includes(token.toLowerCase())
          );
        const pathBoost = needsPath ? ` Path: ${pathTokens.join(" ")}` : "";
        return {
          ...memory,
          confidence: 0.95,
          content: `${memory.content}${pathBoost}`,
          keywords: coreKeywords,
          status: "verified" as const
        };
      }
      if (testCase.hardNegativeIds.has(memory.memoryId)) {
        return {
          ...memory,
          confidence: 0.78,
          keywords: [...new Set([...stuffTokens, ...memory.keywords])],
          status: "verified" as const
        };
      }
      return memory;
    });
    const hardFirst = [
      ...memories.filter((memory) => testCase.hardNegativeIds.has(memory.memoryId)),
      ...memories.filter((memory) => testCase.relevantIds.has(memory.memoryId)),
      ...memories.filter(
        (memory) =>
          !testCase.hardNegativeIds.has(memory.memoryId) && !testCase.relevantIds.has(memory.memoryId)
      )
    ];
    return { ...testCase, memories: hardFirst };
  });
}

interface RankerMetrics {
  hardNegativeSuppressionRate: number;
  hardNegativesSuppressed: number;
  hardNegativesTotal: number;
  mrr: number;
  name: RankerName;
  noiseSuppressed: number;
  noiseSuppressionRate: number;
  noiseTotal: number;
  precisionAt3: number;
  recallAt3: number;
  top1Accuracy: number;
}

function evaluateRanker(name: RankerName, cases: RecallCase[], rank: (testCase: RecallCase) => RankedItem[]): RankerMetrics {
  let top1Hits = 0;
  let recallAt3Sum = 0;
  let precisionSum = 0;
  let rrSum = 0;
  let hardSuppressed = 0;
  let hardTotal = 0;
  let noiseSuppressed = 0;
  let noiseTotal = 0;

  for (const testCase of cases) {
    const ranked = rank(testCase);
    const rankedIds = ranked.map((item) => item.memoryId);

    if (rankedIds[0] !== undefined && testCase.relevantIds.has(rankedIds[0])) {
      top1Hits += 1;
    }

    const top3 = rankedIds.slice(0, 3);
    const relevantInTop3 = top3.filter((id) => testCase.relevantIds.has(id)).length;
    recallAt3Sum += relevantInTop3 > 0 ? 1 : 0;
    precisionSum += relevantInTop3 / 3;

    const firstRelevantRank = rankedIds.findIndex((id) => testCase.relevantIds.has(id));
    rrSum += firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;

    for (const hardId of testCase.hardNegativeIds) {
      hardTotal += 1;
      const hardRank = rankedIds.indexOf(hardId);
      const suppressed = hardRank === -1 || (firstRelevantRank >= 0 && hardRank > firstRelevantRank);
      if (suppressed) {
        hardSuppressed += 1;
      }
    }

    const noiseIds = testCase.memories
      .filter(
        (memory) =>
          !testCase.relevantIds.has(memory.memoryId) &&
          !testCase.hardNegativeIds.has(memory.memoryId) &&
          (memory.status === "stale" || memory.status === "rejected" || memory.confidence < 0.75)
      )
      .map((memory) => memory.memoryId);
    for (const noiseId of noiseIds) {
      noiseTotal += 1;
      const noiseRank = rankedIds.indexOf(noiseId);
      const suppressed = noiseRank === -1 || (firstRelevantRank >= 0 && noiseRank > firstRelevantRank);
      if (suppressed) {
        noiseSuppressed += 1;
      }
    }
  }

  const n = cases.length;
  return {
    hardNegativeSuppressionRate: pct(hardSuppressed, hardTotal),
    hardNegativesSuppressed: hardSuppressed,
    hardNegativesTotal: hardTotal,
    mrr: Number((rrSum / n).toFixed(4)),
    name,
    noiseSuppressed,
    noiseSuppressionRate: pct(noiseSuppressed, noiseTotal),
    noiseTotal,
    precisionAt3: Number((precisionSum / n).toFixed(4)),
    recallAt3: pct(recallAt3Sum, n),
    top1Accuracy: pct(top1Hits, n)
  };
}

function runRecallBenchmark(): {
  cases: number;
  lifts: {
    vsKeyword: { mrrDelta: number; top1Pp: number };
    vsKeywordSubstring: { mrrDelta: number; top1Pp: number };
    vsStrongestBaseline: {
      baseline: RankerName;
      mrrDelta: number;
      top1Pp: number;
    };
  };
  metrics: RankerMetrics[];
} {
  const engine = new RecallEngine();
  const cases = hardenCases(buildRecallCases());

  const metrics = [
    evaluateRanker("full_signal", cases, (testCase) => rankFullSignal(engine, testCase.memories, testCase.query, 5)),
    evaluateRanker("baseline_keyword", cases, (testCase) => rankBaselineKeyword(testCase.memories, testCase.query, 5)),
    evaluateRanker("baseline_keyword_substring", cases, (testCase) =>
      rankBaselineKeywordSubstring(testCase.memories, testCase.query, 5)
    )
  ];

  const full = metrics.find((item) => item.name === "full_signal")!;
  const keyword = metrics.find((item) => item.name === "baseline_keyword")!;
  const keywordSub = metrics.find((item) => item.name === "baseline_keyword_substring")!;
  const strongest =
    keywordSub.top1Accuracy > keyword.top1Accuracy ||
    (keywordSub.top1Accuracy === keyword.top1Accuracy && keywordSub.mrr >= keyword.mrr)
      ? keywordSub
      : keyword;

  return {
    cases: cases.length,
    lifts: {
      vsKeyword: {
        mrrDelta: Number((full.mrr - keyword.mrr).toFixed(4)),
        top1Pp: Number((full.top1Accuracy - keyword.top1Accuracy).toFixed(2))
      },
      vsKeywordSubstring: {
        mrrDelta: Number((full.mrr - keywordSub.mrr).toFixed(4)),
        top1Pp: Number((full.top1Accuracy - keywordSub.top1Accuracy).toFixed(2))
      },
      vsStrongestBaseline: {
        baseline: strongest.name,
        mrrDelta: Number((full.mrr - strongest.mrr).toFixed(4)),
        top1Pp: Number((full.top1Accuracy - strongest.top1Accuracy).toFixed(2))
      }
    },
    metrics
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function parseJsonOutPath(argv: string[]): string | null {
  const index = argv.indexOf("--json");
  if (index < 0) {
    return null;
  }
  return argv[index + 1] ?? join("eval-artifacts", "memory-recall", "ablation.json");
}

function main(): void {
  console.log("=== A. Context governance (long coding sessions, offline) ===");
  const context = runContextBenchmark();
  for (const row of context.rows) {
    console.log(`  ${row}`);
  }
  console.log(`  configs=${SESSION_CONFIGS.length}`);
  console.log(`  average prompt-token compression = ${context.avgCompression}%`);
  console.log(`  maximum prompt-token compression = ${context.maxCompression}%`);
  console.log(
    `  tool-output cap=${DEFAULT_TOOL_OUTPUT_MAX_TOKENS} tokens/result; retained tool-result groups=${DEFAULT_TOOL_RESULT_KEEP_GROUPS}`
  );

  console.log("");
  console.log("=== B. Memory recall ablation (hard negatives + baselines) ===");
  const recall = runRecallBenchmark();
  console.log(`  labeled cases = ${recall.cases}`);
  for (const metric of recall.metrics) {
    console.log(
      `  [${metric.name}] top1=${metric.top1Accuracy}% recall@3=${metric.recallAt3}% ` +
        `precision@3=${metric.precisionAt3} mrr=${metric.mrr} ` +
        `hardNegSuppressed=${metric.hardNegativesSuppressed}/${metric.hardNegativesTotal} (${metric.hardNegativeSuppressionRate}%) ` +
        `noiseSuppressed=${metric.noiseSuppressed}/${metric.noiseTotal} (${metric.noiseSuppressionRate}%)`
    );
  }
  console.log(
    `  lift vs baseline_keyword: ΔTop-1 ${recall.lifts.vsKeyword.top1Pp >= 0 ? "+" : ""}${recall.lifts.vsKeyword.top1Pp} pp, ` +
      `ΔMRR ${recall.lifts.vsKeyword.mrrDelta >= 0 ? "+" : ""}${recall.lifts.vsKeyword.mrrDelta}`
  );
  console.log(
    `  lift vs baseline_keyword_substring: ΔTop-1 ${recall.lifts.vsKeywordSubstring.top1Pp >= 0 ? "+" : ""}${recall.lifts.vsKeywordSubstring.top1Pp} pp, ` +
      `ΔMRR ${recall.lifts.vsKeywordSubstring.mrrDelta >= 0 ? "+" : ""}${recall.lifts.vsKeywordSubstring.mrrDelta}`
  );
  console.log(
    `  lift vs strongest baseline (${recall.lifts.vsStrongestBaseline.baseline}): ` +
      `ΔTop-1 ${recall.lifts.vsStrongestBaseline.top1Pp >= 0 ? "+" : ""}${recall.lifts.vsStrongestBaseline.top1Pp} pp, ` +
      `ΔMRR ${recall.lifts.vsStrongestBaseline.mrrDelta >= 0 ? "+" : ""}${recall.lifts.vsStrongestBaseline.mrrDelta}`
  );

  const jsonPath = parseJsonOutPath(process.argv.slice(2));
  if (jsonPath !== null) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          context: {
            avgCompression: context.avgCompression,
            configs: SESSION_CONFIGS.length,
            maxCompression: context.maxCompression
          },
          memory: recall
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    console.log(`  wrote ${jsonPath}`);
  }
}

main();

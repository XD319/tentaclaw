import { describe, expect, it } from "vitest";

import { buildLayeredMemoryView } from "../src/memory/memory-view.js";
import type { ExecutionCheckpointRecord, ExperienceRecord, MemoryRecord } from "../src/types/index.js";

describe("layered memory view", () => {
  it("groups persisted, runtime, and reference layers", () => {
    const now = new Date().toISOString();
    const memories: MemoryRecord[] = [
      createMemory("m-profile", "profile", "u:executor"),
      createMemory("m-project", "project", "d:/workspace")
    ];
    const checkpoint: ExecutionCheckpointRecord = {
      iteration: 2,
      memoryContext: [
        {
          confidence: 0.88,
          explanation: "runtime context",
          fragmentId: "frag-1",
          memoryId: "m-working-1",
          privacyLevel: "internal",
          retentionPolicy: {
            kind: "working",
            reason: "active task",
            ttlDays: null
          },
          scope: "working",
          sourceType: "tool_output",
          status: "verified",
          text: "working context",
          title: "Working context"
        }
      ],
      messages: [],
      pendingToolCalls: [],
      taskId: "task-1",
      updatedAt: now
    };
    const experiences: ExperienceRecord[] = [
      {
        confidence: 0.8,
        content: "exp content",
        createdAt: now,
        experienceId: "exp-1",
        indexSignals: {
          errorCodes: [],
          paths: [],
          phrases: [],
          reviewers: [],
          scopes: [],
          sourceTypes: ["task"],
          statuses: ["accepted"],
          taskStatuses: [],
          tokens: ["exp"],
          types: ["pattern"],
          valueScore: 0.9
        },
        keywordPhrases: [],
        keywords: ["exp"],
        metadata: {},
        promotedAt: null,
        promotedMemoryId: null,
        promotionTarget: null,
        provenance: {
          reviewerId: null,
          sourceLabel: "test",
          taskId: "task-1",
          toolCallId: null,
          traceEventId: null
        },
        reviewedAt: null,
        scope: { paths: [], scope: "project", scopeKey: "d:/workspace" },
        sourceType: "task",
        status: "accepted",
        summary: "exp summary",
        title: "Experience",
        type: "pattern",
        updatedAt: now,
        valueScore: 0.9
      }
    ];

    const view = buildLayeredMemoryView({
      checkpoint,
      experiences,
      memories,
      scopeKey: "task-1",
      skills: {
        issues: [],
        skills: []
      }
    });

    expect(view.profile).toHaveLength(1);
    expect(view.project).toHaveLength(1);
    expect(view.working).toHaveLength(1);
    expect(view.working[0]?.scope).toBe("working");
    expect(view.experience_ref).toHaveLength(1);
    expect(view.skill_ref).toHaveLength(0);
  });
});

function createMemory(memoryId: string, scope: "profile" | "project", scopeKey: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    confidence: 0.9,
    conflictsWith: [],
    content: "content",
    createdAt: now,
    expiresAt: null,
    keywords: ["k"],
    lastVerifiedAt: null,
    memoryId,
    metadata: {},
    privacyLevel: "internal",
    retentionPolicy: {
      kind: scope,
      reason: "test",
      ttlDays: null
    },
    scope,
    scopeKey,
    source: {
      label: "test",
      sourceType: "manual_review",
      taskId: null,
      toolCallId: null,
      traceEventId: null
    },
    sourceType: "manual_review",
    status: "verified",
    summary: "summary",
    supersedes: null,
    title: "title",
    updatedAt: now
  };
}

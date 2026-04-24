import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { PromotionAdvisor } from "../src/experience/promotion/promotion-advisor.js";
import { SkillDraftManager } from "../src/skills/skill-draft-manager.js";
import { SkillVersionRegistry } from "../src/skills/versioning/skill-version-registry.js";
import type { AuditLogDraft, ExperienceRecord, TraceEvent, TraceEventDraft } from "../src/types/index.js";

describe("promotion advisor", () => {
  it("creates a draft, trace, audit, and version for qualifying group", () => {
    const workspace = mkdtempSync(join(tmpdir(), "promotion-advisor-"));
    try {
      const traces: TraceEvent[] = [];
      const audits: Array<{ action: string; outcome: string }> = [];
      const events = createEventBus();
      const advisor = new PromotionAdvisor({
        auditService: {
          record: (
            event: Omit<AuditLogDraft, "auditId" | "createdAt"> &
              Partial<Pick<AuditLogDraft, "auditId" | "createdAt">>
          ) => {
            audits.push({ action: event.action, outcome: event.outcome });
            return event as never;
          }
        } as never,
        config: {
          enabled: true,
          maxHumanJudgmentWeight: 0.4,
          minStability: 0.6,
          minSuccessCount: 3,
          minSuccessRate: 0.8,
          riskDenyKeywords: ["secret"]
        },
        experiencePlane: {
          list: () => [
            createExperience("exp-1"),
            createExperience("exp-2"),
            createExperience("exp-3")
          ]
        } as never,
        skillDraftManager: new SkillDraftManager({ workspaceRoot: workspace }),
        skillVersionRegistry: new SkillVersionRegistry(workspace),
        traceService: {
          record: (event: TraceEventDraft) => {
            const trace = { ...event, eventId: "evt", sequence: 1, timestamp: "2026-04-23T00:00:00.000Z" } as TraceEvent;
            traces.push(trace);
            events.emit(trace);
            return trace;
          },
          subscribe: events.subscribe
        } as never
      });
      const decisions = advisor.evaluate({ taskId: "task-1" });
      expect(decisions.some((decision) => decision.accepted)).toBe(true);
      expect(traces.some((event) => event.eventType === "skill_promotion_suggested")).toBe(true);
      expect(audits.some((entry) => entry.action === "skill_promoted" && entry.outcome === "pending")).toBe(true);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("skips failure-heavy or reviewer-heavy groups", () => {
    const workspace = mkdtempSync(join(tmpdir(), "promotion-advisor-negative-"));
    try {
      const advisor = new PromotionAdvisor({
        auditService: { record: () => ({}) } as never,
        config: {
          enabled: true,
          maxHumanJudgmentWeight: 0.2,
          minStability: 0.6,
          minSuccessCount: 3,
          minSuccessRate: 0.8,
          riskDenyKeywords: ["approval"]
        },
        experiencePlane: {
          list: () => [
            createExperience("exp-a", { sourceType: "reviewer", title: "Approval flow" }),
            createExperience("exp-b", { sourceType: "reviewer", title: "Approval flow" })
          ]
        } as never,
        skillDraftManager: new SkillDraftManager({ workspaceRoot: workspace }),
        skillVersionRegistry: new SkillVersionRegistry(workspace),
        traceService: { record: () => ({}), subscribe: () => () => undefined } as never
      });
      const decisions = advisor.evaluate({ taskId: "task-2" });
      expect(decisions.every((decision) => !decision.accepted)).toBe(true);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});

function createEventBus(): {
  subscribe: (listener: (event: TraceEvent) => void) => () => void;
  emit: (event: TraceEvent) => void;
} {
  const listeners = new Set<(event: TraceEvent) => void>();
  return {
    emit: (event: TraceEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe: (listener: (event: TraceEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function createExperience(id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    confidence: 0.9,
    content: "retry and verify output",
    createdAt: "2026-04-23T00:00:00.000Z",
    experienceId: id,
    indexSignals: {
      errorCodes: [],
      paths: ["src/a.ts"],
      phrases: [],
      reviewers: [],
      scopes: [],
      sourceTypes: [],
      statuses: [],
      taskStatuses: [],
      tokens: [],
      types: [],
      valueScore: 0.8
    },
    keywordPhrases: ["retry verify"],
    keywords: ["retry", "verify"],
    metadata: {
      taskStatus: "succeeded"
    },
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
    reviewedAt: "2026-04-23T00:00:00.000Z",
    scope: {
      paths: ["src/a.ts"],
      scope: "project",
      scopeKey: "repo"
    },
    sourceType: "task",
    status: "accepted",
    summary: "retry verify pattern",
    title: "Retry verify pattern",
    type: "task_outcome",
    updatedAt: "2026-04-23T00:00:00.000Z",
    valueScore: 0.8,
    ...overrides
  };
}

import { computePromotionSignals, groupByPattern } from "./promotion-signals.js";
import type { AuditService } from "../../audit/audit-service.js";
import type { ExperiencePlane } from "../experience-plane.js";
import type { SkillDraftManager } from "../../skills/skill-draft-manager.js";
import type { SkillVersionRegistry } from "../../skills/versioning/skill-version-registry.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { PromotionAdvice, PromotionDecision, TraceEvent } from "../../types/index.js";

export interface PromotionAdvisorConfig {
  enabled: boolean;
  minSuccessCount: number;
  minSuccessRate: number;
  minStability: number;
  maxHumanJudgmentWeight: number;
  riskDenyKeywords: string[];
}

export interface PromotionAdvisorDependencies {
  experiencePlane: ExperiencePlane;
  skillDraftManager: SkillDraftManager;
  skillVersionRegistry: SkillVersionRegistry;
  traceService: TraceService;
  auditService: AuditService;
  config: PromotionAdvisorConfig;
}

export class PromotionAdvisor {
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly dependencies: PromotionAdvisorDependencies) {}

  public start(): void {
    if (!this.dependencies.config.enabled || this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = this.dependencies.traceService.subscribe((event: TraceEvent) => {
      if (event.eventType !== "experience_reviewed" && event.eventType !== "experience_promoted") {
        return;
      }
      this.evaluate({ taskId: event.taskId });
    });
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  public evaluate(options?: { taskId?: string }): PromotionDecision[] {
    if (!this.dependencies.config.enabled) {
      return [];
    }
    const accepted = this.dependencies.experiencePlane.list({
      statuses: ["accepted", "promoted"]
    });
    const related = this.dependencies.experiencePlane.list();
    const groups = groupByPattern(accepted).filter((group) => group.experiences.length >= 2);
    const decisions: PromotionDecision[] = [];
    for (const group of groups) {
      const signals = computePromotionSignals(group, related, this.dependencies.config.riskDenyKeywords);
      const acceptedDecision =
        signals.successCount >= this.dependencies.config.minSuccessCount &&
        signals.successRate >= this.dependencies.config.minSuccessRate &&
        signals.stability >= this.dependencies.config.minStability &&
        signals.humanJudgmentWeight <= this.dependencies.config.maxHumanJudgmentWeight &&
        signals.riskLevel !== "high";
      const advice = toAdvice(group.experiences, signals);
      const decision: PromotionDecision = {
        accepted: acceptedDecision,
        advice,
        reason: acceptedDecision ? "group_meets_promotion_thresholds" : "group_did_not_meet_thresholds"
      };
      decisions.push(decision);

      if (!acceptedDecision) {
        continue;
      }
      const targetSkillId = `project:${advice.namespace}/${advice.skillName}`;
      const current = this.dependencies.skillVersionRegistry.currentVersion(targetSkillId);
      const nextVersion = bumpMinorVersion(current?.version ?? "0.0.0");
      const draft = this.dependencies.skillDraftManager.createDraftFromAdvice(advice, {
        previousVersion: current?.version ?? null,
        version: nextVersion
      });
      const versionEntry = this.dependencies.skillVersionRegistry.recordVersion({
        draftId: draft.draftId,
        metadata: { signals },
        previousVersion: current?.version ?? null,
        reason: advice.rationale,
        skillId: targetSkillId,
        sourceExperienceIds: advice.sourceExperienceIds
      });

      this.dependencies.traceService.record({
        actor: "promotion.advisor",
        eventType: "skill_promotion_suggested",
        payload: {
          draftId: draft.draftId,
          humanJudgmentWeight: signals.humanJudgmentWeight,
          previousVersion: versionEntry.previousVersion,
          reasons: signals.reasons,
          riskLevel: signals.riskLevel,
          sourceExperienceIds: advice.sourceExperienceIds,
          stability: signals.stability,
          successCount: signals.successCount,
          successRate: signals.successRate,
          targetSkillId: draft.targetSkillId,
          version: versionEntry.version
        },
        stage: "memory",
        summary: `Skill promotion suggested for ${draft.targetSkillId}`,
        taskId: options?.taskId ?? "promotion-advisor"
      });

      this.dependencies.auditService.record({
        action: "skill_promoted",
        actor: "promotion.advisor",
        approvalId: null,
        outcome: "pending",
        payload: {
          draftId: draft.draftId,
          reason: advice.rationale,
          sourceExperienceIds: advice.sourceExperienceIds,
          targetSkillId: draft.targetSkillId,
          version: versionEntry.version
        },
        summary: `Skill promotion suggestion generated for ${draft.targetSkillId}`,
        taskId: options?.taskId ?? "promotion-advisor",
        toolCallId: null
      });
    }
    return decisions;
  }
}

function toAdvice(
  experiences: Array<{
    experienceId: string;
    title: string;
    summary: string;
    content: string;
    keywords: string[];
    keywordPhrases: string[];
  }>,
  signals: ReturnType<typeof computePromotionSignals>
): PromotionAdvice {
  const first = experiences[0];
  if (first === undefined) {
    throw new Error("At least one experience is required for promotion advice.");
  }
  return {
    antiPatterns: ["Avoid applying this skill when prerequisites are unknown."],
    applicability: [
      `Use when tasks resemble: ${first.title}`,
      `Stable repeated pattern with success rate ${(signals.successRate * 100).toFixed(0)}%`
    ],
    category: "pattern",
    description: first.summary,
    examples: experiences.slice(0, 2).map((item) => ({
      input: item.summary,
      output: item.content
    })),
    namespace: "experience",
    rationale: signals.reasons.join("; "),
    risks: [
      `Risk level evaluated as ${signals.riskLevel}.`,
      "Rollback if production behavior deviates from expected outcomes."
    ],
    signals,
    skillName: normalizeSkillName(first.title),
    sourceExperienceIds: experiences.map((item) => item.experienceId),
    title: first.title
  };
}

function normalizeSkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fa5-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
}

function bumpMinorVersion(version: string): string {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number.parseInt(majorRaw ?? "0", 10);
  const minor = Number.parseInt(minorRaw ?? "0", 10);
  const safeMajor = Number.isNaN(major) ? 0 : major;
  const safeMinor = Number.isNaN(minor) ? 0 : minor;
  return `${safeMajor}.${safeMinor + 1}.0`;
}

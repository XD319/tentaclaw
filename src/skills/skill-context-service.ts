import { randomUUID } from "node:crypto";

import { tokenize, uniqueStrings } from "../recall/recall-engine.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { ContextFragment, SkillMetadata, TaskRecord } from "../types/index.js";

export interface SkillContextServiceOptions {
  limit?: number;
  registry: SkillRegistry;
}

interface RankedSkill {
  metadata: SkillMetadata;
  score: number;
}

export class SkillContextService {
  private readonly limit: number;

  public constructor(private readonly options: SkillContextServiceOptions) {
    this.limit = options.limit ?? 5;
  }

  public buildContext(task: TaskRecord): ContextFragment[] {
    return this.rankSkills(task)
      .slice(0, this.limit)
      .map((candidate) => toContextFragment(candidate.metadata, candidate.score));
  }

  public rankSkills(task: Pick<TaskRecord, "cwd" | "input">): RankedSkill[] {
    const queryTokens = tokenize(`${task.input} ${task.cwd}`);
    if (queryTokens.length === 0) {
      return [];
    }

    return this.options.registry
      .listSkills()
      .skills.map((metadata) => ({
        metadata,
        score: scoreSkill(metadata, queryTokens)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.metadata.id.localeCompare(right.metadata.id));
  }
}

function scoreSkill(metadata: SkillMetadata, queryTokens: string[]): number {
  const skillTokens = uniqueStrings(
    tokenize(
      [
        metadata.id,
        metadata.name,
        metadata.namespace,
        metadata.category,
        metadata.description,
        ...metadata.tags,
        ...metadata.relatedSkills
      ].join(" ")
    )
  );
  const query = new Set(queryTokens);
  const overlap = skillTokens.filter((token) => query.has(token)).length;
  return overlap / Math.max(1, Math.min(skillTokens.length, query.size));
}

function toContextFragment(metadata: SkillMetadata, score: number): ContextFragment {
  return {
    confidence: Number(score.toFixed(4)),
    explanation: `skill metadata matched task with score=${score.toFixed(2)}; full content requires skill_view`,
    fragmentId: randomUUID(),
    memoryId: `skill:${metadata.id}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Skill metadata is loaded only for the active task.",
      ttlDays: null
    },
    scope: "project",
    sourceType: "system",
    status: "verified",
    text: [
      `Relevant skill metadata: ${metadata.id}`,
      `description=${metadata.description}`,
      `category=${metadata.category}`,
      `tags=${metadata.tags.join(",") || "-"}`,
      `attachments references=${metadata.attachmentCounts.references} templates=${metadata.attachmentCounts.templates} scripts=${metadata.attachmentCounts.scripts} assets=${metadata.attachmentCounts.assets}`,
      "Use skill_view with this id only if the full skill body or attachments are necessary."
    ].join("\n"),
    title: `Skill ${metadata.id}`
  };
}

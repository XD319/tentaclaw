import type {
  ExecutionCheckpointRecord,
  ExperienceRecord,
  MemoryRecord,
  MemoryScope,
  MemorySnapshotRecord,
  SkillListResult
} from "../types/index.js";

export interface LayeredMemoryView {
  profile: MemoryRecord[];
  project: MemoryRecord[];
  working: MemoryRecord[];
  experience_ref: ExperienceRecord[];
  skill_ref: SkillListResult["skills"];
}

export function buildLayeredMemoryView(input: {
  memories: MemoryRecord[];
  checkpoint: ExecutionCheckpointRecord | null;
  experiences: ExperienceRecord[];
  skills: SkillListResult;
  scopeKey: string;
}): LayeredMemoryView {
  return {
    experience_ref: input.experiences,
    profile: input.memories.filter((memory) => memory.scope === "profile"),
    project: input.memories.filter((memory) => memory.scope === "project"),
    skill_ref: input.skills.skills,
    working:
      input.checkpoint?.memoryContext.map((fragment) => ({
        confidence: fragment.confidence,
        conflictsWith: [],
        content: fragment.text,
        createdAt: input.checkpoint?.updatedAt ?? new Date(0).toISOString(),
        expiresAt: null,
        keywords: [],
        lastVerifiedAt: null,
        memoryId: fragment.memoryId,
        metadata: {
          runtimeOnly: true
        },
        privacyLevel: fragment.privacyLevel,
        retentionPolicy: fragment.retentionPolicy,
        scope: "working",
        scopeKey: input.scopeKey,
        source: {
          label: "runtime checkpoint fragment",
          sourceType: fragment.sourceType,
          taskId: input.scopeKey,
          toolCallId: null,
          traceEventId: null
        },
        sourceType: fragment.sourceType,
        status: fragment.status,
        summary: fragment.text,
        supersedes: null,
        title: fragment.title,
        updatedAt: input.checkpoint?.updatedAt ?? new Date(0).toISOString()
      })) ?? []
  };
}

export function emptyMemoryScopeResult(scope: MemoryScope): {
  memories: MemoryRecord[];
  snapshots: MemorySnapshotRecord[];
  scope: MemoryScope;
} {
  return {
    memories: [],
    scope,
    snapshots: []
  };
}

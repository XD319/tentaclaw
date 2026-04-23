import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillMarkdown, SkillDraftManager, SkillRegistry } from "../src/skills/index.js";
import type { ExperienceRecord } from "../src/types/index.js";

describe("SkillDraftManager", () => {
  it("creates a skill draft only from accepted experiences", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-draft-"));
    const manager = new SkillDraftManager({ workspaceRoot });

    expect(() => manager.createDraftFromExperience(createExperience({ status: "candidate" }))).toThrow(
      /must be accepted or promoted/u
    );

    const draft = manager.createDraftFromExperience(createExperience({ status: "accepted" }));
    const markdown = readFileSync(draft.draftPath, "utf8");
    const parsed = parseSkillMarkdown(markdown);

    expect(draft.targetSkillId).toBe(`project:experience/${parsed.frontmatter.name}`);
    expect(parsed.frontmatter.metadata.sourceExperienceIds).toEqual(["exp-1"]);
    expect(markdown).toContain("## Provenance");
  });

  it("detects repeated procedural pattern candidates", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-draft-"));
    const manager = new SkillDraftManager({ workspaceRoot });
    const groups = manager.listCandidateGroups([
      createExperience({
        experienceId: "exp-1",
        keywords: ["sqlite", "migration"],
        keywordPhrases: ["sqlite migration"],
        status: "accepted",
        type: "pattern"
      }),
      createExperience({
        experienceId: "exp-2",
        keywords: ["sqlite", "busy"],
        keywordPhrases: ["sqlite migration"],
        status: "promoted",
        type: "pattern"
      }),
      createExperience({
        experienceId: "exp-3",
        keywords: ["sqlite"],
        status: "candidate",
        type: "pattern"
      })
    ]);

    expect(groups[0]).toMatchObject({
      keyword: "sqlite migration",
      sourceExperienceIds: ["exp-1", "exp-2"]
    });
  });

  it("promotes an edited draft into the project SkillRegistry without overwriting", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-draft-"));
    const manager = new SkillDraftManager({ workspaceRoot });
    const draft = manager.createDraftFromExperience(
      createExperience({
        title: "SQLite Migration Flow"
      }),
      {
        namespace: "team",
        skillName: "sqlite_migration"
      }
    );

    const promoted = manager.promoteDraft(draft.draftId);
    expect(promoted.targetSkillId).toBe("project:team/sqlite_migration");
    expect(existsSync(join(workspaceRoot, ".auto-talon", "skills", "team", "sqlite_migration", "SKILL.md"))).toBe(
      true
    );
    expect(
      new SkillRegistry({
        workspaceRoot
      }).listSkills().skills.map((skill) => skill.id)
    ).toEqual(["project:team/sqlite_migration"]);
    expect(() => manager.promoteDraft(draft.draftId)).toThrow(/already exists/u);
  });
});

function createExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const base: ExperienceRecord = {
    confidence: 0.9,
    content: "Run the migration in a short transaction and retry SQLITE_BUSY failures.",
    createdAt: "2026-04-21T00:00:00.000Z",
    experienceId: "exp-1",
    indexSignals: {
      errorCodes: [],
      paths: ["src/storage/migrations.ts"],
      phrases: ["sqlite migration"],
      reviewers: [],
      scopes: ["project:test"],
      sourceTypes: ["task"],
      statuses: ["accepted"],
      taskStatuses: [],
      tokens: ["sqlite", "migration"],
      types: ["pattern"],
      valueScore: 0.9
    },
    keywordPhrases: ["sqlite migration"],
    keywords: ["sqlite", "migration"],
    metadata: {},
    promotedAt: null,
    promotedMemoryId: null,
    promotionTarget: null,
    provenance: {
      reviewerId: "reviewer",
      sourceLabel: "test",
      taskId: "task-1",
      toolCallId: null,
      traceEventId: null
    },
    reviewedAt: "2026-04-21T00:00:00.000Z",
    scope: {
      paths: ["src/storage/migrations.ts"],
      scope: "project",
      scopeKey: "test"
    },
    sourceType: "task",
    status: "accepted",
    summary: "A repeatable SQLite migration workflow.",
    title: "SQLite migration flow",
    type: "pattern",
    updatedAt: "2026-04-21T00:00:00.000Z",
    valueScore: 0.9
  };

  return {
    ...base,
    ...overrides,
    indexSignals: {
      ...base.indexSignals,
      ...(overrides.indexSignals ?? {})
    },
    provenance: {
      ...base.provenance,
      ...(overrides.provenance ?? {})
    },
    scope: {
      ...base.scope,
      ...(overrides.scope ?? {})
    }
  };
}

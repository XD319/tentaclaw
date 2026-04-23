import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatSkillList, formatSkillView } from "../src/cli/formatters.js";
import { createApplication } from "../src/runtime/index.js";
import { RuntimeDashboardQueryService } from "../src/tui/view-models/runtime-dashboard.js";

describe("skill management surface", () => {
  it("surfaces skills through service, formatters, doctor, and dashboard query models", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-surface-"));
    writeSkill(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });

    try {
      const skills = handle.service.listSkills();
      expect(formatSkillList(skills)).toContain("project:team/sqlite_migration");
      expect(formatSkillView(handle.service.viewSkill("project:team/sqlite_migration"))).toContain(
        "Source Experiences: exp-1"
      );
      expect((await handle.service.configDoctor()).skillStats).toMatchObject({
        enabled: 1,
        issues: 0
      });

      const dashboard = new RuntimeDashboardQueryService(handle.service).getDashboard({
        selectedPanel: "skills",
        selectedTaskId: null
      });
      expect(dashboard.skills[0]).toMatchObject({
        id: "project:team/sqlite_migration",
        title: "team/sqlite_migration"
      });

      expect(handle.service.disableSkill("project:team/sqlite_migration").skills).toHaveLength(0);
      expect(handle.service.enableSkill("project:team/sqlite_migration").skills).toHaveLength(1);
    } finally {
      handle.close();
    }
  });
});

function writeSkill(workspaceRoot: string): void {
  const skillRoot = join(workspaceRoot, ".auto-talon", "skills", "team", "sqlite_migration");
  mkdirSync(skillRoot, { recursive: true });
  const frontmatter = {
    category: "database",
    description: "SQLite migration retry workflow.",
    disabled: false,
    metadata: {
      sourceExperienceIds: ["exp-1"]
    },
    name: "sqlite_migration",
    namespace: "team",
    platforms: ["any"],
    prerequisites: {
      commands: [],
      credentials: [],
      env: [],
      notes: []
    },
    relatedSkills: [],
    tags: ["sqlite", "migration"],
    version: "1.0.0"
  };
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# SQLite\n\nProcedure body`,
    "utf8"
  );
}

import { describe, expect, it } from "vitest";

import {
  createAttachment,
  createEmptyAttachmentManifest,
  parseSkillAsset,
  parseSkillMarkdown
} from "../src/skills/index.js";

const validFrontmatter = {
  category: "testing",
  description: "Run the project quality gate in the documented order.",
  disabled: false,
  metadata: {
    sourceExperienceIds: ["exp-1"]
  },
  name: "quality_gate",
  namespace: "auto_talon",
  platforms: ["windows"],
  prerequisites: {
    commands: ["npm"],
    credentials: [],
    env: [],
    notes: []
  },
  relatedSkills: [],
  tags: ["ci", "test"],
  version: "1.0.0"
};

describe("skill asset model", () => {
  it("parses SKILL.md frontmatter and creates metadata", () => {
    const skill = parseSkillAsset({
      attachments: {
        ...createEmptyAttachmentManifest(),
        references: [createAttachment("references", "references/checks.md")]
      },
      markdown: `---\n${JSON.stringify(validFrontmatter, null, 2)}\n---\n# Quality Gate\n\nRun tests first.`,
      rootPath: "C:/repo/.auto-talon/skills/auto_talon/quality_gate",
      skillPath: "C:/repo/.auto-talon/skills/auto_talon/quality_gate/SKILL.md",
      source: "project"
    });

    expect(skill.metadata).toMatchObject({
      attachmentCounts: {
        assets: 0,
        references: 1,
        scripts: 0,
        templates: 0
      },
      id: "project:auto_talon/quality_gate",
      sourceExperienceIds: ["exp-1"]
    });
    expect(skill.body).toContain("Run tests first.");
  });

  it("parses strict line frontmatter without filling missing fields", () => {
    const markdown = [
      "---",
      "name: quality_gate",
      "description: Run the project quality gate in the documented order.",
      "version: 1.0.0",
      "platforms: [\"windows\"]",
      "prerequisites:",
      "  commands: []",
      "  credentials: []",
      "  env: []",
      "  notes: []",
      "metadata: {\"sourceExperienceIds\":[\"exp-1\"]}",
      "disabled: false",
      "namespace: auto_talon",
      "category: testing",
      "tags: [\"ci\"]",
      "relatedSkills: []",
      "---",
      "Body"
    ].join("\n");

    expect(parseSkillMarkdown(markdown).frontmatter.name).toBe("quality_gate");
  });

  it("rejects incomplete frontmatter", () => {
    const markdown = `---\n${JSON.stringify({ ...validFrontmatter, version: undefined })}\n---\nBody`;

    expect(() => parseSkillMarkdown(markdown)).toThrow();
  });

  it("rejects unknown platforms", () => {
    const markdown = `---\n${JSON.stringify({ ...validFrontmatter, platforms: ["solaris"] })}\n---\nBody`;

    expect(() => parseSkillMarkdown(markdown)).toThrow();
  });
});

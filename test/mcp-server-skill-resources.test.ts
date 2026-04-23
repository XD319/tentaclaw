import { describe, expect, it } from "vitest";

import { McpSkillBridge } from "../src/mcp/index.js";

describe("McpSkillBridge", () => {
  it("maps skills into MCP resources and supports resource read", () => {
    const bridge = new McpSkillBridge({
      listSkills: () => ({
        issues: [],
        skills: [
          {
            attachmentCounts: { assets: 0, references: 0, scripts: 0, templates: 0 },
            category: "utility",
            description: "demo skill",
            disabled: false,
            id: "project:test/demo",
            metadata: {},
            name: "demo",
            namespace: "test",
            platforms: ["any"],
            prerequisites: {
              commands: [],
              credentials: [],
              env: [],
              notes: []
            },
            relatedSkills: [],
            source: "project",
            sourceExperienceIds: [],
            tags: ["demo"],
            version: "1.0.0"
          }
        ]
      }),
      viewSkill: () => ({
        attachments: {
          assets: [],
          references: [],
          scripts: [],
          templates: []
        },
        body: "Skill body",
        loadedAttachments: [],
        metadata: {
          attachmentCounts: { assets: 0, references: 0, scripts: 0, templates: 0 },
          category: "utility",
          description: "demo skill",
          disabled: false,
          id: "project:test/demo",
          metadata: {},
          name: "demo",
          namespace: "test",
          platforms: ["any"],
          prerequisites: {
            commands: [],
            credentials: [],
            env: [],
            notes: []
          },
          relatedSkills: [],
          source: "project",
          sourceExperienceIds: [],
          tags: ["demo"],
          version: "1.0.0"
        },
        rootPath: "/tmp",
        skillPath: "/tmp/SKILL.md"
      })
    } as never);
    const resources = bridge.listResources();
    expect(resources.length).toBe(1);

    const first = resources[0];
    if (first === undefined) {
      throw new Error("Expected one resource.");
    }
    const resource = bridge.readResource(first.uri);
    expect(resource).not.toBeNull();
    expect(resource?.mimeType).toBe("text/markdown");
  });
});

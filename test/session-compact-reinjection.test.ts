import { describe, expect, it } from "vitest";

import { buildCapabilityDeclaration } from "../src/memory/capability-declaration-builder.js";

describe("capability declaration reinjection", () => {
  it("includes tools and skill declarations in a system payload", () => {
    const declaration = buildCapabilityDeclaration({
      agentProfileId: "executor",
      availableTools: [
        {
          capability: "filesystem.read",
          description: "Read files",
          inputSchema: { type: "object" },
          name: "file_read",
          privacyLevel: "internal",
          riskLevel: "low"
        }
      ],
      skillContext: [
        {
          confidence: 1,
          explanation: "test",
          fragmentId: "f1",
          memoryId: "skill:project:test/demo",
          privacyLevel: "internal",
          retentionPolicy: { kind: "session", reason: "test", ttlDays: null },
          scope: "project",
          sourceType: "system",
          status: "verified",
          text: "Relevant skill metadata: project:test/demo",
          title: "Skill demo"
        }
      ]
    });

    expect(declaration).toContain("Capability declarations");
    expect(declaration).toContain("file_read");
    expect(declaration).toContain("skill:project:test/demo");
  });
});

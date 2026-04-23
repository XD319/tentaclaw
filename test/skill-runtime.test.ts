import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "skill-runtime-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

describe("Skill runtime integration", () => {
  it("injects only relevant skill metadata into initial context", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-runtime-"));
    writeSkill(workspaceRoot);

    const provider = new ScriptedProvider((input) => {
      const skillFragments = input.memoryContext.filter((fragment) =>
        fragment.memoryId.startsWith("skill:")
      );
      expect(skillFragments).toHaveLength(1);
      expect(skillFragments[0]?.text).toContain("project:team/sqlite_migration");
      expect(skillFragments[0]?.text).not.toContain("SECRET PROCEDURE BODY");
      expect(input.availableTools.map((tool) => tool.name)).toContain("skill_view");
      return finalResponse("done");
    });
    const handle = createApplication(workspaceRoot, {
      provider
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("fix sqlite migration retries", workspaceRoot, handle.config)
      );
      expect(result.task.status).toBe("succeeded");
    } finally {
      handle.close();
    }
  });

  it("loads full skill content through the governed skill_view tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-runtime-"));
    writeSkill(workspaceRoot);
    let callCount = 0;

    const provider = new ScriptedProvider((input) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          message: "Need the full skill.",
          toolCalls: [
            {
              input: {
                attachmentKinds: ["references"],
                skillId: "project:team/sqlite_migration"
              },
              reason: "Relevant skill metadata matched the task.",
              toolCallId: "skill-call-1",
              toolName: "skill_view"
            }
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1
          }
        };
      }

      const toolMessage = input.messages.find((message) => message.toolName === "skill_view");
      expect(toolMessage?.content).toContain("SECRET PROCEDURE BODY");
      expect(toolMessage?.content).toContain("Attachment detail");
      return finalResponse("loaded skill");
    });
    const handle = createApplication(workspaceRoot, {
      provider
    });

    try {
      const options = createDefaultRunOptions(
        "use sqlite migration procedural skill",
        workspaceRoot,
        handle.config
      );
      options.maxIterations = 2;
      const result = await handle.service.runTask(options);
      expect(result.output).toBe("loaded skill");
      expect(handle.service.showTask(result.task.taskId).toolCalls[0]).toMatchObject({
        status: "finished",
        toolName: "skill_view"
      });
    } finally {
      handle.close();
    }
  });
});

function writeSkill(workspaceRoot: string): void {
  const skillRoot = join(workspaceRoot, ".auto-talon", "skills", "team", "sqlite_migration");
  mkdirSync(join(skillRoot, "references"), { recursive: true });
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
    `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# SQLite\n\nSECRET PROCEDURE BODY`,
    "utf8"
  );
  writeFileSync(join(skillRoot, "references", "detail.md"), "Attachment detail", "utf8");
}

function finalResponse(message: string): ProviderResponse {
  return {
    kind: "final",
    message,
    usage: {
      inputTokens: 1,
      outputTokens: 1
    }
  };
}

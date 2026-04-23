import { z } from "zod";

import type { SkillRegistry } from "../skills/index.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const skillViewSchema = z.object({
  attachmentKinds: z.array(z.enum(["references", "templates", "scripts", "assets"])).default([]),
  skillId: z.string().min(1)
});

type SkillViewInput = z.infer<typeof skillViewSchema>;

export class SkillViewTool implements ToolDefinition<typeof skillViewSchema, SkillViewInput> {
  public readonly name = "skill_view";
  public readonly description =
    "Load one relevant skill body and optional attachment contents by skill id.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly inputSchema = skillViewSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      attachmentKinds: {
        type: "array"
      },
      skillId: {
        type: "string"
      }
    },
    required: ["skillId"],
    type: "object"
  };

  public constructor(private readonly registry: SkillRegistry) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<SkillViewInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: `View skill ${parsed.skillId}`
      },
      preparedInput: parsed,
      sandbox: {
        kind: "file",
        operation: "read",
        pathScope: "workspace",
        requestedPath: parsed.skillId,
        resolvedPath: context.workspaceRoot,
        withinExtraWriteRoot: false
      }
    };
  }

  public execute(input: SkillViewInput): Promise<ToolExecutionResult> {
    const view = this.registry.viewSkill(
      input.skillId,
      input.attachmentKinds
    );
    if (view === null) {
      return Promise.resolve({
        errorCode: "tool_validation_error",
        errorMessage: `Skill ${input.skillId} was not found or is not enabled for this runtime.`,
        success: false
      });
    }

    return Promise.resolve({
      output: {
        attachments: view.loadedAttachments.map((attachment) => ({
          content: attachment.content,
          kind: attachment.kind,
          path: attachment.path
        })),
        body: view.body,
        metadata: {
          attachmentCounts: view.metadata.attachmentCounts,
          category: view.metadata.category,
          description: view.metadata.description,
          disabled: view.metadata.disabled,
          id: view.metadata.id,
          metadata: view.metadata.metadata,
          name: view.metadata.name,
          namespace: view.metadata.namespace,
          platforms: view.metadata.platforms,
          prerequisites: view.metadata.prerequisites,
          relatedSkills: view.metadata.relatedSkills,
          source: view.metadata.source,
          sourceExperienceIds: view.metadata.sourceExperienceIds,
          tags: view.metadata.tags,
          version: view.metadata.version
        }
      },
      success: true,
      summary: `Loaded skill ${input.skillId} with ${view.loadedAttachments.length} attachments`
    });
  }
}

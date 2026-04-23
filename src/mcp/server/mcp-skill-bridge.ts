import type { SkillRegistry } from "../../skills/index.js";
import type { SkillAttachmentKind } from "../../types/index.js";

export class McpSkillBridge {
  public constructor(private readonly skillRegistry: SkillRegistry) {}

  public listResources(): Array<{ description: string; name: string; uri: string }> {
    return this.skillRegistry.listSkills().skills.map((skill) => ({
      description: skill.description,
      name: skill.id,
      uri: `skill://${skill.id}`
    }));
  }

  public readResource(uri: string): { contents: string; mimeType: string; uri: string } | null {
    if (!uri.startsWith("skill://")) {
      return null;
    }
    const skillId = uri.slice("skill://".length);
    const skill = this.skillRegistry.viewSkill(skillId, [
      "assets",
      "references",
      "scripts",
      "templates"
    ] as SkillAttachmentKind[]);
    if (skill === null) {
      return null;
    }
    return {
      contents: [
        `# ${skill.metadata.id}`,
        skill.body,
        ...skill.loadedAttachments.map(
          (attachment) => `\n## Attachment: ${attachment.kind}/${attachment.path}\n${attachment.content}`
        )
      ].join("\n"),
      mimeType: "text/markdown",
      uri
    };
  }
}

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { parseSkillMarkdown } from "./skill-asset";
import type {
  ExperienceRecord,
  SkillCandidateGroup,
  SkillDraftRecord,
  SkillFrontmatter
} from "../types";

export interface SkillDraftManagerOptions {
  workspaceRoot: string;
}

export interface CreateSkillDraftOptions {
  namespace?: string;
  skillName?: string;
}

export class SkillDraftManager {
  private readonly workspaceRoot: string;
  private readonly draftsRoot: string;
  private readonly projectSkillsRoot: string;

  public constructor(options: SkillDraftManagerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.draftsRoot = join(this.workspaceRoot, ".auto-talon", "skill-drafts");
    this.projectSkillsRoot = join(this.workspaceRoot, ".auto-talon", "skills");
  }

  public createDraftFromExperience(
    experience: ExperienceRecord,
    options: CreateSkillDraftOptions = {}
  ): SkillDraftRecord {
    assertExperiencePromotable(experience);
    return this.createDraftFromExperiences([experience], options);
  }

  public createDraftFromExperiences(
    experiences: ExperienceRecord[],
    options: CreateSkillDraftOptions = {}
  ): SkillDraftRecord {
    if (experiences.length === 0) {
      throw new Error("At least one experience is required to create a skill draft.");
    }
    for (const experience of experiences) {
      assertExperiencePromotable(experience);
    }

    const primary = experiences[0];
    if (primary === undefined) {
      throw new Error("At least one experience is required to create a skill draft.");
    }

    const namespace = options.namespace ?? "experience";
    const skillName = options.skillName ?? normalizeSkillName(primary.title);
    const draftId = `${namespace}__${skillName}__${Date.now().toString(36)}`;
    const rootPath = join(this.draftsRoot, draftId);
    const draftPath = join(rootPath, "SKILL.md");
    if (existsSync(rootPath)) {
      throw new Error(`Skill draft already exists: ${rootPath}`);
    }

    mkdirSync(rootPath, { recursive: true });
    for (const directoryName of ["references", "templates", "scripts", "assets"]) {
      mkdirSync(join(rootPath, directoryName), { recursive: true });
    }
    writeFileSync(draftPath, renderSkillDraftMarkdown(experiences, namespace, skillName), "utf8");

    return {
      draftId,
      draftPath,
      rootPath,
      sourceExperienceIds: experiences.map((experience) => experience.experienceId),
      targetSkillId: `project:${namespace}/${skillName}`
    };
  }

  public listCandidateGroups(experiences: ExperienceRecord[]): SkillCandidateGroup[] {
    const promotable = experiences.filter(
      (experience) =>
        (experience.status === "accepted" || experience.status === "promoted") &&
        (experience.type === "pattern" || experience.metadata.workflow === true)
    );
    const groups = new Map<string, ExperienceRecord[]>();

    for (const experience of promotable) {
      const keys = [...experience.keywordPhrases, ...experience.keywords, ...experience.scope.paths]
        .map((value) => value.toLowerCase().trim())
        .filter((value) => value.length > 0);
      for (const key of new Set(keys)) {
        groups.set(key, [...(groups.get(key) ?? []), experience]);
      }
    }

    return [...groups.entries()]
      .filter(([, entries]) => new Set(entries.map((entry) => entry.experienceId)).size >= 2)
      .map(([keyword, entries]) => {
        const uniqueEntries = uniqueExperienceRecords(entries);
        return {
          keyword,
          reason: `Repeated procedural pattern matched ${uniqueEntries.length} accepted/promoted experiences.`,
          sourceExperienceIds: uniqueEntries.map((experience) => experience.experienceId),
          title: `Skill candidate for ${keyword}`
        };
      })
      .sort((left, right) => right.sourceExperienceIds.length - left.sourceExperienceIds.length);
  }

  public promoteDraft(draftId: string): SkillDraftRecord {
    const rootPath = resolve(this.draftsRoot, draftId);
    assertWithinRoot(rootPath, this.draftsRoot);
    const draftPath = join(rootPath, "SKILL.md");
    if (!existsSync(draftPath)) {
      throw new Error(`Skill draft ${draftId} does not contain SKILL.md.`);
    }

    const frontmatter = parseSkillMarkdown(readFileSync(draftPath, "utf8")).frontmatter;
    const targetRoot = join(this.projectSkillsRoot, frontmatter.namespace, frontmatter.name);
    assertWithinRoot(targetRoot, this.projectSkillsRoot);
    if (existsSync(targetRoot)) {
      throw new Error(`Target skill already exists: ${targetRoot}`);
    }

    mkdirSync(this.projectSkillsRoot, { recursive: true });
    cpSync(rootPath, targetRoot, { recursive: true });

    return {
      draftId,
      draftPath,
      rootPath,
      sourceExperienceIds: readSourceExperienceIds(frontmatter),
      targetSkillId: `project:${frontmatter.namespace}/${frontmatter.name}`
    };
  }

  public readDraft(draftId: string): SkillDraftRecord {
    const rootPath = resolve(this.draftsRoot, draftId);
    assertWithinRoot(rootPath, this.draftsRoot);
    const draftPath = join(rootPath, "SKILL.md");
    const frontmatter = parseSkillMarkdown(readFileSync(draftPath, "utf8")).frontmatter;

    return {
      draftId,
      draftPath,
      rootPath,
      sourceExperienceIds: readSourceExperienceIds(frontmatter),
      targetSkillId: `project:${frontmatter.namespace}/${frontmatter.name}`
    };
  }
}

function renderSkillDraftMarkdown(
  experiences: ExperienceRecord[],
  namespace: string,
  skillName: string
): string {
  const primary = experiences[0];
  if (primary === undefined) {
    throw new Error("At least one experience is required to render a skill draft.");
  }
  const frontmatter: SkillFrontmatter = {
    category: primary.type,
    description: primary.summary,
    disabled: false,
    metadata: {
      sourceExperienceIds: experiences.map((experience) => experience.experienceId),
      sourceExperienceTitles: experiences.map((experience) => experience.title)
    },
    name: skillName,
    namespace,
    platforms: ["any"],
    prerequisites: {
      commands: [],
      credentials: [],
      env: [],
      notes: []
    },
    relatedSkills: [],
    tags: primary.keywords.slice(0, 6),
    version: "0.1.0"
  };
  const body = [
    `# ${primary.title}`,
    "",
    "## Summary",
    primary.summary,
    "",
    "## Procedure",
    ...experiences.flatMap((experience, index) => [
      `${index + 1}. ${experience.content.trim()}`
    ]),
    "",
    "## Provenance",
    ...experiences.map(
      (experience) =>
        `- ${experience.experienceId} ${experience.provenance.sourceLabel} task=${experience.provenance.taskId ?? "-"}`
    ),
    ""
  ].join("\n");

  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
}

function assertExperiencePromotable(experience: ExperienceRecord): void {
  if (experience.status !== "accepted" && experience.status !== "promoted") {
    throw new Error(`Experience ${experience.experienceId} must be accepted or promoted before skill draft creation.`);
  }
}

function normalizeSkillName(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fa5-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  if (!/^[a-z0-9]/u.test(normalized)) {
    throw new Error(`Experience title cannot be converted to a valid skill name: ${title}`);
  }
  return normalized;
}

function uniqueExperienceRecords(experiences: ExperienceRecord[]): ExperienceRecord[] {
  const seen = new Set<string>();
  const result: ExperienceRecord[] = [];
  for (const experience of experiences) {
    if (seen.has(experience.experienceId)) {
      continue;
    }
    seen.add(experience.experienceId);
    result.push(experience);
  }
  return result;
}

function readSourceExperienceIds(frontmatter: SkillFrontmatter): string[] {
  const value = frontmatter.metadata.sourceExperienceIds;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error("Skill draft metadata.sourceExperienceIds must be a string array.");
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function assertWithinRoot(candidatePath: string, rootPath: string): void {
  const candidate = resolve(candidatePath);
  const root = resolve(rootPath);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path ${candidate} is outside root ${root}.`);
  }
}

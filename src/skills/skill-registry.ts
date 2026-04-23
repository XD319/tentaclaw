import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, platform as currentPlatform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import {
  attachmentKindFromDirectory,
  createAttachment,
  createEmptyAttachmentManifest,
  parseSkillAsset
} from "./skill-asset.js";
import type {
  LoadedSkillAttachment,
  SkillAsset,
  SkillAttachment,
  SkillAttachmentKind,
  SkillAttachmentManifest,
  SkillListResult,
  SkillMetadata,
  SkillPlatform,
  SkillRegistryIssue,
  SkillSource,
  SkillView
} from "../types/index.js";

export interface RemoteSkillSource {
  listMetadata(): SkillListResult;
  view(skillId: string, attachmentKinds?: SkillAttachmentKind[]): SkillView | null;
}

export interface SkillRegistryOptions {
  env?: Record<string, string | undefined>;
  localSkillsRoot?: string;
  platform?: NodeJS.Platform;
  remoteSources?: RemoteSkillSource[];
  workspaceRoot: string;
}

interface SkillOverrideFile {
  disabledSkillIds: string[];
}

interface RegistryCandidate {
  asset: SkillAsset;
  sourceRoot: string;
}

export class SkillRegistry {
  private readonly env: Record<string, string | undefined>;
  private readonly localSkillsRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly projectSkillsRoot: string;
  private readonly remoteSources: RemoteSkillSource[];
  private readonly workspaceRoot: string;

  public constructor(options: SkillRegistryOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.projectSkillsRoot = join(this.workspaceRoot, ".auto-talon", "skills");
    this.localSkillsRoot = resolve(
      options.localSkillsRoot ?? process.env.AGENT_SKILLS_HOME ?? join(homedir(), ".auto-talon", "skills")
    );
    this.platform = options.platform ?? currentPlatform();
    this.env = options.env ?? process.env;
    this.remoteSources = options.remoteSources ?? [];
  }

  public listSkills(): SkillListResult {
    const scan = this.scan();
    return {
      issues: scan.issues,
      skills: scan.skills.map((candidate) => candidate.asset.metadata)
    };
  }

  public viewSkill(skillId: string, attachmentKinds: SkillAttachmentKind[] = []): SkillView | null {
    const scan = this.scan();
    const candidate = scan.skills.find((entry) => entry.asset.metadata.id === skillId);
    if (candidate === undefined) {
      for (const remote of this.remoteSources) {
        const remoteView = remote.view(skillId, attachmentKinds);
        if (remoteView !== null) {
          return remoteView;
        }
      }
      return null;
    }

    const loadedAttachments = attachmentKinds.flatMap((kind) =>
      candidate.asset.attachments[kind].map((attachment) =>
        this.loadAttachment(candidate.asset.rootPath, attachment)
      )
    );

    return {
      ...candidate.asset,
      loadedAttachments
    };
  }

  public disableSkill(skillId: string): SkillListResult {
    const overrides = this.readOverrides();
    if (!overrides.disabledSkillIds.includes(skillId)) {
      overrides.disabledSkillIds.push(skillId);
      this.writeOverrides(overrides);
    }
    return this.listSkills();
  }

  public enableSkill(skillId: string): SkillListResult {
    const overrides = this.readOverrides();
    if (overrides.disabledSkillIds.includes(skillId)) {
      overrides.disabledSkillIds = overrides.disabledSkillIds.filter((entry) => entry !== skillId);
      this.writeOverrides(overrides);
    }
    return this.listSkills();
  }

  private scan(): { issues: SkillRegistryIssue[]; skills: RegistryCandidate[] } {
    const issues: SkillRegistryIssue[] = [];
    const overrides = this.readOverrides();
    const local = this.scanRoot(this.localSkillsRoot, "local", issues);
    const project = this.scanRoot(this.projectSkillsRoot, "project", issues);
    const selected = new Map<string, RegistryCandidate>();

    for (const candidate of local) {
      selected.set(logicalSkillKey(candidate.asset.metadata), candidate);
    }
    for (const candidate of project) {
      const key = logicalSkillKey(candidate.asset.metadata);
      const existing = selected.get(key);
      if (existing !== undefined) {
        issues.push({
          code: "duplicate_shadowed",
          detail: `Project skill ${candidate.asset.metadata.id} shadows ${existing.asset.metadata.id}.`,
          path: existing.asset.rootPath,
          skillId: existing.asset.metadata.id
        });
      }
      selected.set(key, candidate);
    }

    const filtered = [...selected.values()].filter((candidate) =>
      this.isUsable(candidate.asset.metadata, overrides, candidate.asset.rootPath, issues)
    );

    for (const remote of this.remoteSources) {
      const remoteResult = remote.listMetadata();
      issues.push(...remoteResult.issues);
      for (const metadata of remoteResult.skills) {
        if (this.isUsable(metadata, overrides, metadata.id, issues)) {
          filtered.push({
            asset: {
              attachments: createEmptyAttachmentManifest(),
              body: "",
              metadata,
              rootPath: metadata.id,
              skillPath: metadata.id
            },
            sourceRoot: metadata.id
          });
        }
      }
    }

    return {
      issues,
      skills: filtered.sort((left, right) => left.asset.metadata.id.localeCompare(right.asset.metadata.id))
    };
  }

  private scanRoot(
    sourceRoot: string,
    source: Extract<SkillSource, "local" | "project">,
    issues: SkillRegistryIssue[]
  ): RegistryCandidate[] {
    const root = resolve(sourceRoot);
    if (!existsSync(root)) {
      return [];
    }

    return listDirectories(root).flatMap((namespaceRoot) =>
      listDirectories(namespaceRoot).flatMap((skillRoot) => {
        try {
          assertWithinRoot(skillRoot, root);
          const skillPath = join(skillRoot, "SKILL.md");
          if (!existsSync(skillPath)) {
            issues.push({
              code: "invalid_skill",
              detail: "Skill directory does not contain SKILL.md.",
              path: skillRoot,
              skillId: null
            });
            return [];
          }

          const asset = parseSkillAsset({
            attachments: this.discoverAttachments(skillRoot, issues),
            markdown: readFileSync(skillPath, "utf8"),
            rootPath: skillRoot,
            skillPath,
            source
          });

          return [
            {
              asset,
              sourceRoot: root
            }
          ];
        } catch (error) {
          issues.push({
            code: "invalid_skill",
            detail: error instanceof Error ? error.message : String(error),
            path: skillRoot,
            skillId: null
          });
          return [];
        }
      })
    );
  }

  private discoverAttachments(skillRoot: string, issues: SkillRegistryIssue[]): SkillAttachmentManifest {
    const manifest = createEmptyAttachmentManifest();
    for (const directory of listDirectories(skillRoot)) {
      const kind = attachmentKindFromDirectory(directory);
      if (kind === null) {
        continue;
      }
      for (const filePath of listFilesRecursive(directory)) {
        try {
          assertWithinRoot(filePath, skillRoot);
          manifest[kind].push(createAttachment(kind, toPortableRelativePath(skillRoot, filePath)));
        } catch (error) {
          issues.push({
            code: "path_unsafe",
            detail: error instanceof Error ? error.message : String(error),
            path: filePath,
            skillId: null
          });
        }
      }
    }
    return manifest;
  }

  private isUsable(
    metadata: SkillMetadata,
    overrides: SkillOverrideFile,
    path: string,
    issues: SkillRegistryIssue[]
  ): boolean {
    if (metadata.disabled || overrides.disabledSkillIds.includes(metadata.id)) {
      issues.push({
        code: "disabled",
        detail: `Skill ${metadata.id} is disabled.`,
        path,
        skillId: metadata.id
      });
      return false;
    }

    if (!isPlatformCompatible(metadata.platforms, this.platform)) {
      issues.push({
        code: "platform_incompatible",
        detail: `Skill ${metadata.id} does not support platform ${this.platform}.`,
        path,
        skillId: metadata.id
      });
      return false;
    }

    const missing = [...metadata.prerequisites.credentials, ...metadata.prerequisites.env].filter(
      (key) => this.env[key] === undefined || this.env[key]?.trim().length === 0
    );
    if (missing.length > 0) {
      issues.push({
        code: "credential_missing",
        detail: `Skill ${metadata.id} is missing prerequisites: ${missing.join(", ")}.`,
        path,
        skillId: metadata.id
      });
      return false;
    }

    return true;
  }

  private loadAttachment(skillRoot: string, attachment: SkillAttachment): LoadedSkillAttachment {
    const resolvedPath = resolve(skillRoot, attachment.path);
    assertWithinRoot(resolvedPath, skillRoot);
    return {
      ...attachment,
      content: readFileSync(resolvedPath, "utf8")
    };
  }

  private readOverrides(): SkillOverrideFile {
    const path = this.overridePath();
    if (!existsSync(path)) {
      return {
        disabledSkillIds: []
      };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillOverrideFile;
    if (!Array.isArray(parsed.disabledSkillIds)) {
      throw new Error(`Invalid skill override file: ${path}`);
    }
    return parsed;
  }

  private writeOverrides(overrides: SkillOverrideFile): void {
    const path = this.overridePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
  }

  private overridePath(): string {
    return join(this.workspaceRoot, ".auto-talon", "skill-overrides.json");
  }
}

function listDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

function listFilesRecursive(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursive(path) : [path];
  });
}

function assertWithinRoot(candidatePath: string, rootPath: string): void {
  const candidate = resolve(candidatePath);
  const root = resolve(rootPath);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes("..\\")) {
    throw new Error(`Path ${candidate} is outside root ${root}.`);
  }
}

function toPortableRelativePath(rootPath: string, candidatePath: string): string {
  return relative(rootPath, candidatePath).replace(/\\/gu, "/");
}

function logicalSkillKey(metadata: SkillMetadata): string {
  return `${metadata.namespace}/${metadata.name}`;
}

function isPlatformCompatible(platforms: SkillPlatform[], platform: NodeJS.Platform): boolean {
  return platforms.includes("any") || platforms.includes(toSkillPlatform(platform));
}

function toSkillPlatform(platform: NodeJS.Platform): SkillPlatform {
  if (platform === "win32") {
    return "windows";
  }
  if (platform === "darwin") {
    return "darwin";
  }
  return "linux";
}

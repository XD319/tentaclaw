import { basename } from "node:path";

import { z } from "zod";

import {
  SKILL_ATTACHMENT_KINDS,
  skillAssetSchema,
  skillAttachmentManifestSchema,
  skillFrontmatterSchema,
  type SkillAsset,
  type SkillAttachment,
  type SkillAttachmentKind,
  type SkillAttachmentManifest,
  type SkillFrontmatter,
  type SkillSource
} from "../types/index.js";

export interface ParseSkillAssetInput {
  attachments: SkillAttachmentManifest;
  markdown: string;
  rootPath: string;
  skillPath: string;
  source: SkillSource;
}

export function parseSkillAsset(input: ParseSkillAssetInput): SkillAsset {
  const parsedMarkdown = parseSkillMarkdown(input.markdown);
  const attachments = skillAttachmentManifestSchema.parse(input.attachments);
  const metadata = {
    ...parsedMarkdown.frontmatter,
    attachmentCounts: countAttachments(attachments),
    id: createSkillId(input.source, parsedMarkdown.frontmatter.namespace, parsedMarkdown.frontmatter.name),
    source: input.source,
    sourceExperienceIds: readSourceExperienceIds(parsedMarkdown.frontmatter.metadata)
  };

  return skillAssetSchema.parse({
    attachments,
    body: parsedMarkdown.body,
    metadata,
    rootPath: input.rootPath,
    skillPath: input.skillPath
  });
}

export function parseSkillMarkdown(markdown: string): {
  body: string;
  frontmatter: SkillFrontmatter;
} {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    throw new Error("SKILL.md must start with YAML frontmatter.");
  }

  const newline = markdown.startsWith("---\r\n") ? "\r\n" : "\n";
  const closingMarker = `${newline}---${newline}`;
  const closingIndex = markdown.indexOf(closingMarker, 3);
  if (closingIndex < 0) {
    throw new Error("SKILL.md frontmatter closing marker was not found.");
  }

  const rawFrontmatter = markdown.slice(3 + newline.length, closingIndex);
  const body = markdown.slice(closingIndex + closingMarker.length);
  const frontmatter = skillFrontmatterSchema.parse(parseStrictFrontmatter(rawFrontmatter));

  return {
    body,
    frontmatter
  };
}

export function createEmptyAttachmentManifest(): SkillAttachmentManifest {
  return {
    assets: [],
    references: [],
    scripts: [],
    templates: []
  };
}

export function createAttachment(kind: SkillAttachmentKind, path: string): SkillAttachment {
  return {
    kind,
    path
  };
}

export function createSkillId(source: SkillSource, namespace: string, name: string): string {
  return `${source}:${namespace}/${name}`;
}

function parseStrictFrontmatter(rawFrontmatter: string): unknown {
  const source = rawFrontmatter.trim();
  if (source.length === 0) {
    throw new Error("SKILL.md frontmatter must not be empty.");
  }

  try {
    return JSON.parse(source) as unknown;
  } catch {
    return parseLineFrontmatter(source);
  }
}

function parseLineFrontmatter(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/u);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (/^\s/u.test(line)) {
      throw new Error(`Invalid frontmatter indentation at line ${index + 1}.`);
    }

    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u);
    if (match === null) {
      throw new Error(`Invalid frontmatter entry at line ${index + 1}.`);
    }

    const key = match[1];
    const inlineValue = match[2] ?? "";
    if (key === undefined) {
      throw new Error(`Invalid frontmatter key at line ${index + 1}.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`Duplicate frontmatter key "${key}".`);
    }

    if (inlineValue.trim().length > 0) {
      result[key] = parseScalarOrInlineJson(inlineValue.trim());
      index += 1;
      continue;
    }

    const block = collectIndentedBlock(lines, index + 1);
    result[key] = parseBlockValue(block.lines, key);
    index = block.nextIndex;
  }

  return result;
}

function collectIndentedBlock(lines: string[], startIndex: number): {
  lines: string[];
  nextIndex: number;
} {
  const blockLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (!/^\s/u.test(line)) {
      break;
    }
    blockLines.push(line);
    index += 1;
  }

  if (blockLines.length === 0) {
    throw new Error(`Missing frontmatter block value before line ${startIndex + 1}.`);
  }

  return {
    lines: blockLines,
    nextIndex: index
  };
}

function parseBlockValue(lines: string[], key: string): unknown {
  if (lines.every((line) => line.trimStart().startsWith("- "))) {
    return lines.map((line) => parseScalarOrInlineJson(line.trimStart().slice(2).trim()));
  }

  const value: Record<string, unknown> = {};
  for (const line of lines) {
    const trimmed = line.trimStart();
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u);
    if (match === null || match[1] === undefined) {
      throw new Error(`Invalid object value in frontmatter key "${key}".`);
    }
    const childKey = match[1];
    if (Object.prototype.hasOwnProperty.call(value, childKey)) {
      throw new Error(`Duplicate frontmatter key "${key}.${childKey}".`);
    }
    value[childKey] = parseScalarOrInlineJson(match[2]?.trim() ?? "");
  }
  return value;
}

function parseScalarOrInlineJson(value: string): unknown {
  if (value.length === 0) {
    throw new Error("Empty frontmatter values are not allowed.");
  }
  if (
    value.startsWith("[") ||
    value.startsWith("{") ||
    value === "true" ||
    value === "false" ||
    value === "null" ||
    /^-?\d+(?:\.\d+)?$/u.test(value)
  ) {
    return JSON.parse(value) as unknown;
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function countAttachments(
  attachments: SkillAttachmentManifest
): Record<SkillAttachmentKind, number> {
  return Object.fromEntries(
    SKILL_ATTACHMENT_KINDS.map((kind) => [kind, attachments[kind].length])
  ) as Record<SkillAttachmentKind, number>;
}

function readSourceExperienceIds(metadata: Record<string, unknown>): string[] {
  const value = metadata.sourceExperienceIds;
  if (value === undefined) {
    return [];
  }
  return z.array(z.string().min(1)).parse(value);
}

export function attachmentKindFromDirectory(directoryName: string): SkillAttachmentKind | null {
  const normalized = basename(directoryName).toLowerCase();
  return SKILL_ATTACHMENT_KINDS.find((kind) => kind === normalized) ?? null;
}

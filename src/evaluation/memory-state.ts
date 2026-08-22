import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { AppRuntimeHandle } from "../runtime/index.js";
import { writeMemoryEnabled } from "../runtime/runtime-config.js";
import type { EvalMemoryState } from "./schema.js";
import { seedWorkspace } from "./workspace.js";

export async function prepareMemoryEvalWorkspace(
  workspaceRoot: string,
  state: EvalMemoryState
): Promise<void> {
  writeMemoryEnabled(workspaceRoot, true);
  await seedWorkspace(workspaceRoot, state.skills);
}

export function materializeMemoryState(
  handle: AppRuntimeHandle,
  state: EvalMemoryState,
  workspaceRoot: string
): void {
  for (const memory of state.memories) {
    handle.infrastructure.storage.memories.create({
      confidence: 0.95,
      content: memory.content,
      expiresAt: null,
      keywords: memory.keywords.length > 0 ? memory.keywords : tokenize(memory.title, memory.content),
      privacyLevel: "internal",
      retentionPolicy: {
        kind: memory.scope,
        reason: "Eval memory fixture.",
        ttlDays: 90
      },
      scope: memory.scope,
      scopeKey: memory.scope === "project" ? workspaceRoot : "eval-runner:executor",
      source: {
        label: "eval-memory-fixture",
        sourceType: "manual_review",
        taskId: null,
        toolCallId: null,
        traceEventId: null
      },
      status: memory.status,
      summary: memory.summary ?? memory.content.slice(0, 160),
      tier: memory.tier,
      title: memory.title
    });
  }
  for (const experience of state.experiences) {
    handle.infrastructure.storage.experiences.create({
      confidence: 0.9,
      content: experience.content,
      indexSignals: {
        errorCodes: [],
        paths: [],
        phrases: [],
        reviewers: ["eval"],
        scopes: ["project"],
        sourceTypes: ["manual_import"],
        statuses: [experience.status],
        taskStatuses: [],
        tokens: tokenize(experience.title, experience.content),
        types: [experience.type],
        valueScore: 0.8
      },
      keywords: tokenize(experience.title, experience.content),
      provenance: {
        reviewerId: "eval-runner",
        sourceLabel: "eval-experience-fixture",
        taskId: null,
        toolCallId: null,
        traceEventId: null
      },
      scope: {
        paths: [],
        scope: "project",
        scopeKey: workspaceRoot
      },
      sourceType: "manual_import",
      status: experience.status,
      summary: experience.summary,
      title: experience.title,
      type: experience.type,
      valueScore: 0.8
    });
  }
}

export function freezeMemoryState(handle: AppRuntimeHandle, workspaceRoot: string): EvalMemoryState {
  const memories = handle.infrastructure.storage.memories.list({
    includeArchived: false,
    includeExpired: false,
    includeRejected: false,
    includeStale: false
  }).map((memory) => ({
    content: memory.content,
    keywords: memory.keywords,
    scope: memory.scope === "profile" ? "profile" as const : "project" as const,
    status: memory.status,
    summary: memory.summary,
    tier: memory.tier,
    title: memory.title
  }));
  const experiences = handle.infrastructure.storage.experiences.list({
    statuses: ["accepted", "promoted"]
  }).map((experience) => ({
    content: experience.content,
    status: experience.status,
    summary: experience.summary,
    title: experience.title,
    type: experience.type
  }));
  return {
    experiences,
    memories,
    skills: readSkillFiles(join(workspaceRoot, ".auto-talon", "skills"))
  };
}

export function writeFrozenMemoryState(outputPath: string, state: EvalMemoryState): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readSkillFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.isFile()) {
        const relativePath = relative(root, absolute).replaceAll("\\", "/");
        files[join(".auto-talon", "skills", relativePath).replaceAll("\\", "/")] = readFileSync(absolute, "utf8");
      }
    }
  };
  try {
    if (statSync(root).isDirectory()) {
      walk(root);
    }
  } catch {
    return files;
  }
  return files;
}

function tokenize(...parts: string[]): string[] {
  return [...new Set(parts.join(" ").toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 1))];
}

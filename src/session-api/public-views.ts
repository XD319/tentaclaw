import type {
  ModelSelectionEntry,
  ModelSelectionView
} from "../runtime/operations/model-selection-service.js";
import type { ConfiguredProviderEntry } from "../runtime/operations/provider-switch-service.js";
import type { JsonObject } from "../types/index.js";

export function publicConfiguredProviders(
  entries: ConfiguredProviderEntry[]
): JsonObject[] {
  return entries.map((entry) => ({
    displayName: entry.displayName,
    model: entry.model,
    name: entry.name,
    source: entry.configSource
  }));
}

export function publicModelSelectionView(view: ModelSelectionView): JsonObject {
  return {
    aliases: view.aliases,
    auxiliary: view.auxiliary,
    configuredModels: view.configuredModels.map(publicModelSelectionEntry),
    current: publicModelSelectionEntry(view.current),
    envOnlyProviders: view.envOnlyProviders,
    fallback: view.fallback,
    fallbackProviders: view.fallbackProviders,
    routing: view.routing,
    session: view.session
  };
}

function publicModelSelectionEntry(entry: ModelSelectionEntry): JsonObject {
  return {
    baseUrl: entry.baseUrl,
    configSource: entry.configSource,
    contextWindowTokens: entry.contextWindowTokens,
    current: entry.current,
    displayName: entry.displayName,
    model: entry.model,
    providerName: entry.providerName,
    selection: entry.selection,
    source: entry.source,
    strict: entry.strict,
    transport: entry.transport
  };
}

const LIST_LIMIT = 80;
const PREVIEW_LENGTH = 240;
const ACTIVE_TASK_STATUSES = new Set([
  "pending",
  "running",
  "waiting_approval",
  "waiting_clarification",
  "waiting_tool"
]);

function previewText(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.length === 0) {
    return undefined;
  }
  return value.length <= PREVIEW_LENGTH ? value : `${value.slice(0, PREVIEW_LENGTH)}…`;
}

export function publicTaskList(
  tasks: Array<{ input: string; sessionId?: string | null; status: string; taskId: string }>
): JsonObject[] {
  const seen = new Set<string>();
  const picked: Array<{ input: string; sessionId?: string | null; status: string; taskId: string }> = [];
  for (const task of [
    ...tasks.filter((entry) => ACTIVE_TASK_STATUSES.has(entry.status)),
    ...tasks.slice(0, LIST_LIMIT)
  ]) {
    if (seen.has(task.taskId)) {
      continue;
    }
    seen.add(task.taskId);
    picked.push(task);
  }
  return picked.map((task) => {
    const input = previewText(task.input);
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.sessionId !== undefined && task.sessionId !== null ? { sessionId: task.sessionId } : {}),
      ...(input !== undefined ? { input } : {})
    };
  });
}

export function publicInboxList(
  items: Array<{ inboxId: string; summary: string; title: string }>
): JsonObject[] {
  return items.slice(0, LIST_LIMIT).map((item) => {
    const summary = previewText(item.summary);
    return {
      inboxId: item.inboxId,
      title: item.title,
      ...(summary !== undefined ? { summary } : {})
    };
  });
}

export function publicMemoryList(
  memories: Array<{ content: string; memoryId: string; title: string }>
): JsonObject[] {
  return memories.slice(0, LIST_LIMIT).map((memory) => {
    const content = previewText(memory.content);
    return {
      memoryId: memory.memoryId,
      title: memory.title,
      ...(content !== undefined ? { content } : {})
    };
  });
}

export function publicExperienceList(
  experiences: Array<{ experienceId: string; summary?: string; title?: string }>
): JsonObject[] {
  return experiences.slice(0, LIST_LIMIT).map((experience) => {
    const summary = previewText(experience.summary);
    return {
      experienceId: experience.experienceId,
      title: experience.title ?? experience.experienceId,
      ...(summary !== undefined ? { summary } : {})
    };
  });
}

export function publicScheduleList(
  schedules: Array<{ name: string; scheduleId: string; status?: string }>
): JsonObject[] {
  return schedules.slice(0, LIST_LIMIT).map((schedule) => ({
    name: schedule.name,
    scheduleId: schedule.scheduleId,
    ...(schedule.status !== undefined ? { status: schedule.status } : {})
  }));
}

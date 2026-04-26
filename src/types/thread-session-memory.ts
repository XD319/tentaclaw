import type { JsonObject } from "./common.js";

export const THREAD_SESSION_MEMORY_TRIGGERS = ["compact", "manual", "resume", "final"] as const;

export type ThreadSessionMemoryTrigger = (typeof THREAD_SESSION_MEMORY_TRIGGERS)[number];

export interface ThreadSessionMemoryRecord {
  sessionMemoryId: string;
  threadId: string;
  runId: string | null;
  taskId: string | null;
  trigger: ThreadSessionMemoryTrigger;
  summary: string;
  goal: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  createdAt: string;
  metadata: JsonObject;
}

export interface ThreadSessionMemoryDraft {
  sessionMemoryId?: string;
  threadId: string;
  runId?: string | null;
  taskId?: string | null;
  trigger: ThreadSessionMemoryTrigger;
  summary: string;
  goal: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  metadata?: JsonObject;
}

export interface SessionSearchHit {
  sessionMemoryId: string;
  threadId: string;
  score: number;
  summary: string;
  goal: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  createdAt: string;
}

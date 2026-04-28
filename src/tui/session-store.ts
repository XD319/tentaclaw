import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChatMessage } from "./view-models/chat-messages.js";

export interface PersistedChatSession {
  id: string;
  messages: ChatMessage[];
  sessionApprovalFingerprints?: string[];
  threadId?: string;
  updatedAt: string;
}

export function getSessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".auto-talon", "sessions");
}

export function getDraftsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".auto-talon", "drafts");
}

export async function ensureSessionsDir(workspaceRoot: string): Promise<string> {
  const dir = getSessionsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureDraftsDir(workspaceRoot: string): Promise<string> {
  const dir = getDraftsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveSession(workspaceRoot: string, session: PersistedChatSession): Promise<void> {
  const dir = await ensureSessionsDir(workspaceRoot);
  const path = join(dir, `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 2), "utf8");
}

export async function loadSession(workspaceRoot: string, sessionId: string): Promise<PersistedChatSession | null> {
  try {
    const raw = await readFile(join(getSessionsDir(workspaceRoot), `${sessionId}.json`), "utf8");
    const parsed = JSON.parse(raw) as PersistedChatSession;
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) {
      return null;
    }
    if (
      parsed.sessionApprovalFingerprints !== undefined &&
      !Array.isArray(parsed.sessionApprovalFingerprints)
    ) {
      return null;
    }
    if (parsed.threadId !== undefined && typeof parsed.threadId !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function listSessionIds(workspaceRoot: string): Promise<string[]> {
  try {
    const dir = getSessionsDir(workspaceRoot);
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/u, ""));
  } catch {
    return [];
  }
}

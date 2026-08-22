export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : payload !== null && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}

export interface BootstrapResponse {
  catalog: string[];
  configuredProviders: Array<{ name: string; source: string }>;
  models: {
    current?: { selection: string; displayName?: string };
    configuredModels?: Array<{ selection: string; displayName: string; current?: boolean }>;
  };
  provider: { configured: boolean; displayName: string; model: string | null; name: string };
  providers: Array<{ displayName: string; name: string; transport: string }>;
  userId: string;
  workspaceRoot: string;
}

export interface SessionIndexEntry {
  messageCount?: number;
  preview?: string;
  sessionId: string;
  status?: string;
  title?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  eventType?: string;
  id: string;
  kind: string;
  text: string;
  timestamp?: string;
}

export interface ApprovalRecord {
  approvalId: string;
  reason?: string;
  status: string;
  summary?: string;
  taskId?: string;
  toolName?: string;
}

export interface ClarifyPrompt {
  promptId: string;
  prompt?: string;
  question?: string;
  options?: Array<{ id: string; label: string }>;
}

export interface FileChange {
  artifactId: string;
  artifactType: string;
  content?: {
    path?: string;
    operation?: string;
    unifiedDiff?: string;
  };
  uri?: string;
}

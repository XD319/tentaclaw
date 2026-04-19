import { randomUUID } from "node:crypto";

import React from "react";

import { createDefaultRunOptions, type AgentApplicationService, type AppConfig } from "../../runtime";
import type { ApprovalRecord, TaskRecord, ToolCallRecord, TraceEvent } from "../../types";
import {
  contextWindowPercent,
  estimateSessionCostUsd
} from "../token-pricing";
import {
  resolveApprovalMessage,
  toApprovalMessage,
  toTraceActivityMessage,
  type ChatMessage
} from "../view-models/chat-messages";

export interface UseChatControllerOptions {
  config: AppConfig;
  cwd: string;
  initialMessages?: ChatMessage[];
  reviewerId: string;
  service: AgentApplicationService;
}

export interface TokenHud {
  contextPercent: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface FileEditEntry {
  at: string;
  path: string;
  taskId: string;
}

export interface ChatController {
  activeTaskId: string | null;
  addSystemMessage: (text: string) => void;
  busy: boolean;
  clearConversation: () => void;
  fileEdits: FileEditEntry[];
  formatDiffSummary: () => string;
  hasPendingApproval: boolean;
  messages: ChatMessage[];
  pendingApproval: ApprovalRecord | null;
  requestInterrupt: () => boolean;
  runDurationLabel: string;
  statusLine: string;
  submitPrompt: (text: string) => Promise<void>;
  resolvePendingApproval: (action: "allow" | "deny") => Promise<void>;
  summary: {
    pendingApprovals: number;
    runningTasks: number;
    tasks: number;
  };
  tokenHud: TokenHud;
}

const welcomeMessage: ChatMessage = {
  id: "system:welcome",
  kind: "system",
  text: "Welcome to auto-talon chat mode. Type a prompt and press Enter to send.",
  timestamp: new Date().toISOString()
};

export function useChatController(input: UseChatControllerOptions): ChatController {
  const [messages, setMessages] = React.useState<ChatMessage[]>(() =>
    input.initialMessages !== undefined && input.initialMessages.length > 0 ? input.initialMessages : [welcomeMessage]
  );
  const [busy, setBusy] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState("idle");
  const [summary, setSummary] = React.useState({
    pendingApprovals: 0,
    runningTasks: 0,
    tasks: 0
  });
  const [pendingApproval, setPendingApproval] = React.useState<ApprovalRecord | null>(null);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [fileEdits, setFileEdits] = React.useState<FileEditEntry[]>([]);
  const [tokenHud, setTokenHud] = React.useState<TokenHud>({
    contextPercent: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0
  });

  const startedAtRef = React.useRef(Date.now());
  const activeAbortControllerRef = React.useRef<AbortController | null>(null);
  const activeTaskIdRef = React.useRef<string | null>(null);
  const lastSequenceByTaskRef = React.useRef<Record<string, number>>({});
  const seenApprovalMessageIdsRef = React.useRef<Set<string>>(new Set());
  const activeTraceUnsubscribeRef = React.useRef<(() => void) | null>(null);
  const streamingAgentIdRef = React.useRef<string | null>(null);
  const streamedAnyRef = React.useRef(false);

  const stopTraceSubscription = React.useCallback(() => {
    activeTraceUnsubscribeRef.current?.();
    activeTraceUnsubscribeRef.current = null;
  }, []);

  const recordFileWrite = React.useCallback(
    (taskId: string, toolCallId: string, at: string) => {
      const detail = input.service.showTask(taskId);
      const toolCall = detail.toolCalls.find((item) => item.toolCallId === toolCallId);
      if (toolCall === undefined || toolCall.toolName !== "file_write") {
        return;
      }
      const pathValue = toolCall.input["path"];
      const path = typeof pathValue === "string" ? pathValue : "?";
      setFileEdits((current) => [...current, { at, path, taskId }]);
    },
    [input.service]
  );

  const startTraceSubscription = React.useCallback(
    (taskId: string) => {
      stopTraceSubscription();
      activeTraceUnsubscribeRef.current = input.service.subscribeToTaskTrace(taskId, (event) => {
        lastSequenceByTaskRef.current[taskId] = Math.max(
          lastSequenceByTaskRef.current[taskId] ?? 0,
          event.sequence
        );
        setMessages((current) => mergeTraceMessages(current, [event]));
        if (event.eventType === "tool_call_finished" && event.payload.toolName === "file_write") {
          recordFileWrite(event.taskId, event.payload.toolCallId, event.timestamp);
        }
      });
    },
    [input.service, recordFileWrite, stopTraceSubscription]
  );

  const addSystemMessage = React.useCallback((text: string) => {
    setMessages((current) => [
      ...current,
      {
        id: `system:${Date.now()}`,
        kind: "system",
        text,
        timestamp: new Date().toISOString()
      }
    ]);
  }, []);

  const clearConversation = React.useCallback(() => {
    setMessages([welcomeMessage]);
    setStatusLine("conversation cleared");
    setActiveTaskId(null);
    activeTaskIdRef.current = null;
    setFileEdits([]);
    stopTraceSubscription();
  }, [stopTraceSubscription]);

  const refresh = React.useCallback(() => {
    try {
      const tasks = input.service.listTasks();
      const approvals = input.service.listPendingApprovals();
      const runningTasks = tasks.filter((task) => task.status === "running").length;
      setSummary({
        pendingApprovals: approvals.length,
        runningTasks,
        tasks: tasks.length
      });
      const activeApproval =
        approvals.find((item) => item.taskId === activeTaskIdRef.current) ?? approvals[0] ?? null;
      setPendingApproval(activeApproval);
      setMessages((current) => appendApprovalMessages(current, approvals, input.service, seenApprovalMessageIdsRef.current));

      const stats = input.service.providerStats();
      if (stats !== null) {
        const usage = stats.tokenUsage;
        const pct = contextWindowPercent(
          usage,
          input.config.tokenBudget.inputLimit,
          input.config.tokenBudget.outputLimit
        );
        const cost = estimateSessionCostUsd(
          stats.providerName,
          input.config.provider.model ?? undefined,
          usage
        );
        setTokenHud({
          contextPercent: pct,
          estimatedCostUsd: cost,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens
        });
      }
    } catch (error) {
      setStatusLine(error instanceof Error ? `refresh failed: ${error.message}` : "refresh failed");
    }
  }, [input.config.provider.model, input.config.tokenBudget.inputLimit, input.config.tokenBudget.outputLimit, input.service]);

  React.useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1_000);
    return () => {
      clearInterval(interval);
      stopTraceSubscription();
    };
  }, [refresh, stopTraceSubscription]);

  const runDurationLabel = formatDuration(Date.now() - startedAtRef.current);

  const appendNewTraceEvents = React.useCallback(
    (taskId: string) => {
      const trace = input.service.traceTask(taskId);
      const lastSeen = lastSequenceByTaskRef.current[taskId] ?? 0;
      const unseen = trace.filter((event) => event.sequence > lastSeen);
      if (unseen.length === 0) {
        return;
      }
      lastSequenceByTaskRef.current[taskId] = unseen.at(-1)?.sequence ?? lastSeen;
      setMessages((current) => mergeTraceMessages(current, unseen));
      for (const event of unseen) {
        if (event.eventType === "tool_call_finished" && event.payload.toolName === "file_write") {
          recordFileWrite(event.taskId, event.payload.toolCallId, event.timestamp);
        }
      }
    },
    [input.service, recordFileWrite]
  );

  const removeStreamingMessage = React.useCallback((id: string | null) => {
    if (id === null) {
      return;
    }
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const submitPrompt = React.useCallback(
    async (text: string) => {
      setBusy(true);
      setStatusLine("running");
      const taskId = randomUUID();
      activeTaskIdRef.current = taskId;
      setActiveTaskId(taskId);
      startTraceSubscription(taskId);
      streamedAnyRef.current = false;
      streamingAgentIdRef.current = `agent:stream:${taskId}`;

      setMessages((current) => [
        ...current,
        {
          id: `user:${Date.now()}`,
          kind: "user",
          text,
          timestamp: new Date().toISOString()
        }
      ]);

      try {
        const runOptions = createDefaultRunOptions(text, input.cwd, input.config);
        const abortController = new AbortController();
        activeAbortControllerRef.current = abortController;
        runOptions.signal = abortController.signal;
        runOptions.taskId = taskId;
        runOptions.onAssistantTextDelta = (delta: string) => {
          streamedAnyRef.current = true;
          const streamId = streamingAgentIdRef.current;
          if (streamId === null) {
            return;
          }
          setMessages((current) => {
            const index = current.findIndex((message) => message.id === streamId);
            if (index === -1) {
              return [
                ...current,
                {
                  id: streamId,
                  kind: "agent" as const,
                  streaming: true,
                  text: delta,
                  timestamp: new Date().toISOString()
                }
              ];
            }
            const message = current[index];
            if (message === undefined || message.kind !== "agent") {
              return current;
            }
            const next = [...current];
            next[index] = {
              ...message,
              streaming: true,
              text: `${message.text}${delta}`
            } satisfies Extract<ChatMessage, { kind: "agent" }>;
            return next;
          });
        };

        const result = await input.service.runTask(runOptions);
        activeTaskIdRef.current = result.task.taskId;
        setActiveTaskId(result.task.taskId);
        appendNewTraceEvents(result.task.taskId);

        const streamId = streamingAgentIdRef.current;
        streamingAgentIdRef.current = null;

        const runError = result.error;
        if (runError !== undefined) {
          if (streamedAnyRef.current) {
            removeStreamingMessage(streamId);
          }
          setMessages((current) => [
            ...current,
            {
              code: runError.code,
              id: `error:${result.task.taskId}:${Date.now()}`,
              kind: "error",
              message: runError.message,
              source: "runtime",
              timestamp: new Date().toISOString()
            }
          ]);
          setStatusLine(`failed: ${runError.code}`);
          return;
        }

        const messageText = result.output ?? summarizeTaskResult(result.task);
        if (streamedAnyRef.current && streamId !== null) {
          setMessages((current) =>
            current.map((message) => {
              if (message.id !== streamId || message.kind !== "agent") {
                return message;
              }
              return { ...message, streaming: false, text: messageText };
            })
          );
        } else {
          removeStreamingMessage(streamId);
          setMessages((current) => [
            ...current,
            {
              id: `agent:${result.task.taskId}:${Date.now()}`,
              kind: "agent",
              text: messageText,
              timestamp: new Date().toISOString()
            }
          ]);
        }
        setStatusLine(result.task.status);
      } catch (error) {
        const streamId = streamingAgentIdRef.current;
        streamingAgentIdRef.current = null;
        if (streamedAnyRef.current) {
          removeStreamingMessage(streamId);
        }

        const aborted =
          error instanceof Error &&
          (error.name === "AbortError" ||
            error.message.toLowerCase().includes("abort") ||
            error.message.toLowerCase().includes("aborted"));

        if (aborted) {
          addSystemMessage("Interrupted current task.");
          setStatusLine("interrupted");
          return;
        }

        setMessages((current) => [
          ...current,
          {
            code: "runtime_error",
            id: `error:submit:${Date.now()}`,
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
            source: "runtime",
            timestamp: new Date().toISOString()
          }
        ]);
        setStatusLine("failed to run task");
      } finally {
        activeAbortControllerRef.current = null;
        streamingAgentIdRef.current = null;
        streamedAnyRef.current = false;
        setBusy(false);
        stopTraceSubscription();
        refresh();
      }
    },
    [
      addSystemMessage,
      appendNewTraceEvents,
      input.config,
      input.cwd,
      input.service,
      refresh,
      removeStreamingMessage,
      startTraceSubscription,
      stopTraceSubscription
    ]
  );

  const formatDiffSummary = React.useCallback((): string => {
    if (fileEdits.length === 0) {
      return "No file_write operations recorded in this session yet.";
    }
    const lines = fileEdits.map((entry, index) => `${String(index + 1).padStart(2, " ")}. ${entry.path} (task ${entry.taskId.slice(0, 8)})`);
    return `Session file changes (${fileEdits.length}):\n${lines.join("\n")}`;
  }, [fileEdits]);

  const resolvePendingApproval = React.useCallback(
    async (action: "allow" | "deny") => {
      if (pendingApproval === null || busy) {
        return;
      }

      setBusy(true);
      startTraceSubscription(pendingApproval.taskId);
      try {
        const result = await input.service.resolveApproval(pendingApproval.approvalId, action, input.reviewerId);
        appendNewTraceEvents(result.task.taskId);
        activeTaskIdRef.current = result.task.taskId;
        setActiveTaskId(result.task.taskId);
        setMessages((current) =>
          current.map((message) => {
            if (message.kind === "approval" && message.approval.approvalId === pendingApproval.approvalId) {
              return resolveApprovalMessage(message, action);
            }
            return message;
          })
        );
        if (result.output !== null) {
          setMessages((current) => [
            ...current,
            {
              id: `agent:${result.task.taskId}:${Date.now()}`,
              kind: "agent",
              text: result.output ?? "",
              timestamp: new Date().toISOString()
            }
          ]);
        }
        setStatusLine(`${action === "allow" ? "approved" : "denied"} ${pendingApproval.toolName}`);
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            code: "approval_failed",
            id: `error:approval:${Date.now()}`,
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
            source: "approval",
            timestamp: new Date().toISOString()
          }
        ]);
        setStatusLine("approval failed");
      } finally {
        setBusy(false);
        stopTraceSubscription();
        refresh();
      }
    },
    [
      appendNewTraceEvents,
      busy,
      input.reviewerId,
      input.service,
      pendingApproval,
      refresh,
      startTraceSubscription,
      stopTraceSubscription
    ]
  );

  const requestInterrupt = React.useCallback((): boolean => {
    const controller = activeAbortControllerRef.current;
    if (controller === null) {
      return false;
    }
    controller.abort();
    return true;
  }, []);

  return {
    activeTaskId,
    addSystemMessage,
    busy,
    clearConversation,
    fileEdits,
    formatDiffSummary,
    hasPendingApproval: pendingApproval !== null,
    messages,
    pendingApproval,
    requestInterrupt,
    resolvePendingApproval,
    runDurationLabel,
    statusLine,
    submitPrompt,
    summary,
    tokenHud
  };
}

function appendApprovalMessages(
  current: ChatMessage[],
  approvals: ApprovalRecord[],
  service: AgentApplicationService,
  seenIds: Set<string>
): ChatMessage[] {
  const next = [...current];
  for (const approval of approvals) {
    const messageId = `approval:${approval.approvalId}`;
    if (seenIds.has(messageId)) {
      continue;
    }
    const toolCall = findToolCall(service, approval);
    next.push(toApprovalMessage(approval, toolCall));
    seenIds.add(messageId);
  }
  return next;
}

function findToolCall(
  service: AgentApplicationService,
  approval: ApprovalRecord
): ToolCallRecord | null {
  return service.showTask(approval.taskId).toolCalls.find((item) => item.toolCallId === approval.toolCallId) ?? null;
}

export function mergeTraceMessages(current: ChatMessage[], events: TraceEvent[]): ChatMessage[] {
  const existingIds = new Set(current.map((message) => message.id));
  const next = [...current];
  for (const event of events) {
    const message = toTraceActivityMessage(event);
    if (!existingIds.has(message.id)) {
      next.push(message);
      existingIds.add(message.id);
    }
  }
  return next;
}

function summarizeTaskResult(task: TaskRecord): string {
  if (task.finalOutput !== null && task.finalOutput.length > 0) {
    return task.finalOutput;
  }
  if (task.errorMessage !== null) {
    return task.errorMessage;
  }
  return `Task ${task.taskId.slice(0, 8)} finished with status ${task.status}.`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainSeconds}s`;
  }
  return `${minutes}m ${remainSeconds}s`;
}

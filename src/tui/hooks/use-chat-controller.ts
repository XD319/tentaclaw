import { randomUUID } from "node:crypto";

import React from "react";

import { createDefaultRunOptions, type AgentApplicationService, type AppConfig } from "../../runtime/index.js";
import type { ApprovalRecord, TaskRecord, ToolCallRecord, TraceEvent } from "../../types/index.js";
import {
  contextWindowPercent,
  estimateSessionCostUsd
} from "../token-pricing.js";
import {
  toApprovalResultMessage,
  toApprovalMessage,
  toTraceActivityMessage,
  type ChatMessage
} from "../view-models/chat-messages.js";
import type { UiStatus } from "../ui-status.js";

export interface UseChatControllerOptions {
  config: AppConfig;
  cwd: string;
  initialMessages?: ChatMessage[];
  initialThreadId?: string;
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
  activeThreadId: string | null;
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
  submitPrompt: (text: string) => boolean;
  resolvePendingApproval: (action: "allow" | "deny") => Promise<void>;
  summary: {
    pendingApprovals: number;
    runningTasks: number;
    tasks: number;
  };
  tokenHud: TokenHud;
  uiStatus: UiStatus;
}

const welcomeMessage: ChatMessage = {
  id: "system:welcome",
  kind: "system",
  text: "Welcome to your AutoTalon personal assistant. Type a request and press Enter to start.",
  timestamp: new Date().toISOString()
};
const STREAM_FLUSH_INTERVAL_MS = 50;
const STREAM_FLUSH_MAX_CHARS = 1_024;

export function useChatController(input: UseChatControllerOptions): ChatController {
  const [messages, setMessages] = React.useState<ChatMessage[]>(() =>
    input.initialMessages !== undefined && input.initialMessages.length > 0 ? input.initialMessages : [welcomeMessage]
  );
  const [busyCount, setBusyCount] = React.useState(0);
  const [statusLine, setStatusLine] = React.useState("idle");
  const [summary, setSummary] = React.useState({
    pendingApprovals: 0,
    runningTasks: 0,
    tasks: 0
  });
  const [pendingApproval, setPendingApproval] = React.useState<ApprovalRecord | null>(null);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(input.initialThreadId ?? null);
  const [fileEdits, setFileEdits] = React.useState<FileEditEntry[]>([]);
  const [tokenHud, setTokenHud] = React.useState<TokenHud>({
    contextPercent: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0
  });
  const [uiStatus, setUiStatus] = React.useState<UiStatus>({
    approvalLabel: null,
    primaryLabel: "idle",
    primaryTone: "muted",
    runState: "idle",
    taskLabel: null
  });

  const startedAtRef = React.useRef(Date.now());
  const activeAbortControllerRef = React.useRef<AbortController | null>(null);
  const activeTaskIdRef = React.useRef<string | null>(null);
  const activeThreadIdRef = React.useRef<string | null>(input.initialThreadId ?? null);
  const lastSequenceByTaskRef = React.useRef<Record<string, number>>({});
  const activeTraceUnsubscribeRef = React.useRef<(() => void) | null>(null);
  const streamingAgentIdRef = React.useRef<string | null>(null);
  const streamedAnyRef = React.useRef(false);
  const pendingDeltaRef = React.useRef("");
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalInFlightRef = React.useRef(false);
  const submitInFlightRef = React.useRef(false);
  const seenApprovalMessageIdsRef = React.useRef<Set<string>>(collectApprovalMessageIds(messages));
  const busy = busyCount > 0;

  const beginBusy = React.useCallback(() => {
    setBusyCount((current) => current + 1);
  }, []);

  const endBusy = React.useCallback(() => {
    setBusyCount((current) => Math.max(0, current - 1));
  }, []);

  const flushPendingDelta = React.useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingDeltaRef.current;
    if (pending.length === 0) {
      return;
    }
    pendingDeltaRef.current = "";
    const currentStreamId = streamingAgentIdRef.current;
    if (currentStreamId === null) {
      return;
    }
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === currentStreamId && message.kind === "agent");
      if (index === -1) {
        return [
          ...current,
          {
            id: currentStreamId,
            kind: "agent",
            streaming: true,
            text: pending,
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
        text: `${message.text}${pending}`
      } satisfies Extract<ChatMessage, { kind: "agent" }>;
      return next;
    });
  }, []);

  const cancelPendingDelta = React.useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingDeltaRef.current = "";
  }, []);

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
        id: `system:${randomUUID()}`,
        kind: "system",
        text,
        timestamp: new Date().toISOString()
      }
    ]);
  }, []);

  const clearConversation = React.useCallback(() => {
    setMessages([welcomeMessage]);
    setStatusLine("conversation cleared");
    setUiStatus({
      approvalLabel: null,
      primaryLabel: "conversation cleared",
      primaryTone: "muted",
      runState: "idle",
      taskLabel: null
    });
    setActiveTaskId(null);
    setPendingApproval(null);
    activeTaskIdRef.current = null;
    activeThreadIdRef.current = null;
    seenApprovalMessageIdsRef.current.clear();
    setFileEdits([]);
    setActiveThreadId(null);
    stopTraceSubscription();
  }, [stopTraceSubscription]);

  const refresh = React.useCallback(() => {
    try {
      const tasks = input.service.listTasks();
      const approvals = input.service.listPendingApprovals();
      const runningTasks = tasks.filter((task) => task.status === "running").length;
      const nextSummary = {
        pendingApprovals: approvals.length,
        runningTasks,
        tasks: tasks.length
      };
      setSummary((current) => (summaryEquals(current, nextSummary) ? current : nextSummary));
      const activeApproval =
        approvals.find((item) => item.taskId === activeTaskIdRef.current) ?? approvals[0] ?? null;
      setPendingApproval((current) => (approvalRefEquals(current, activeApproval) ? current : activeApproval));
      if (activeApproval !== null) {
        setStatusLine(`waiting approval: ${activeApproval.toolName}`);
        updateUiStatus(setUiStatus, {
          approvalLabel: activeApproval.toolName,
          primaryLabel: `approval required: ${activeApproval.toolName}`,
          primaryTone: "warn",
          runState: "waiting_approval",
          taskLabel: activeApproval.taskId.slice(0, 8)
        });
      } else if (tasks.length === 0 && !busy) {
        updateUiStatus(setUiStatus, {
          approvalLabel: null,
          primaryLabel: "idle",
          primaryTone: "muted",
          runState: "idle",
          taskLabel: null
        });
      }
      setMessages((current) =>
        syncPendingApprovalMessages(current, approvals, input.service, seenApprovalMessageIdsRef.current)
      );

      const stats = input.service.providerStats();
      if (
        stats !== null &&
        typeof stats === "object" &&
        "providerName" in stats &&
        "tokenUsage" in stats
      ) {
        const typedStats = stats as {
          providerName: string;
          tokenUsage: { inputTokens: number; outputTokens: number; totalTokens?: number };
        };
        const usage = typedStats.tokenUsage;
        const pct = contextWindowPercent(
          usage,
          input.config.tokenBudget.inputLimit,
          input.config.tokenBudget.outputLimit
        );
        const cost = estimateSessionCostUsd(
          typedStats.providerName,
          input.config.provider.model ?? undefined,
          usage
        );
        const nextTokenHud = {
          contextPercent: pct,
          estimatedCostUsd: cost,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens
        };
        setTokenHud((current) => (tokenHudEquals(current, nextTokenHud) ? current : nextTokenHud));
      }
    } catch (error) {
      setStatusLine(error instanceof Error ? `refresh failed: ${error.message}` : "refresh failed");
    }
  }, [busy, input.config.provider.model, input.config.tokenBudget.inputLimit, input.config.tokenBudget.outputLimit, input.service]);

  React.useEffect(() => {
    refresh();
    const interval = setInterval(refresh, busy ? 2_000 : 5_000);
    return () => {
      clearInterval(interval);
      stopTraceSubscription();
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingDeltaRef.current = "";
    };
  }, [busy, refresh, stopTraceSubscription]);

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

  const upsertStreamingAgentMessage = React.useCallback(
    (id: string, text: string, streaming: boolean) => {
      setMessages((current) => {
        const index = current.findIndex((message) => message.id === id);
        if (index === -1) {
          return [
            ...current,
            {
              id,
              kind: "agent",
              streaming,
              text,
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
          streaming,
          text
        } satisfies Extract<ChatMessage, { kind: "agent" }>;
        return next;
      });
    },
    []
  );

  const finalizeStreamingAgentMessage = React.useCallback(
    (id: string, text: string) => {
      setMessages((current) => {
        const index = current.findIndex((message) => message.id === id && message.kind === "agent");
        if (index === -1) {
          return [
            ...current,
            {
              id,
              kind: "agent",
              streaming: false,
              text,
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
          streaming: false,
          text
        } satisfies Extract<ChatMessage, { kind: "agent" }>;
        return next;
      });
    },
    []
  );

  const submitPrompt = React.useCallback(
    (text: string): boolean => {
      if (submitInFlightRef.current) {
        return false;
      }
      submitInFlightRef.current = true;
      beginBusy();
      setStatusLine("running");
      const taskId = randomUUID();
      setUiStatus({
        approvalLabel: null,
        primaryLabel: "running task",
        primaryTone: "accent",
        runState: "running",
        taskLabel: taskId.slice(0, 8)
      });
      const streamId = `agent:stream:${taskId}`;
      activeTaskIdRef.current = taskId;
      setActiveTaskId(taskId);
      startTraceSubscription(taskId);
      streamedAnyRef.current = false;
      streamingAgentIdRef.current = streamId;

      setMessages((current) => [
        ...current,
        {
          id: `user:${randomUUID()}`,
          kind: "user",
          text,
          timestamp: new Date().toISOString()
        }
      ]);

      void (async () => {
        try {
          const runOptions = createDefaultRunOptions(text, input.cwd, input.config);
          const abortController = new AbortController();
          activeAbortControllerRef.current = abortController;
          runOptions.signal = abortController.signal;
          runOptions.taskId = taskId;
          runOptions.onAssistantTextDelta = (delta: string) => {
            streamedAnyRef.current = true;
            if (streamingAgentIdRef.current === null) {
              return;
            }
            pendingDeltaRef.current += delta;
            if (pendingDeltaRef.current.length >= STREAM_FLUSH_MAX_CHARS) {
              flushPendingDelta();
              return;
            }
            if (flushTimerRef.current === null) {
              flushTimerRef.current = setTimeout(flushPendingDelta, STREAM_FLUSH_INTERVAL_MS);
            }
          };

          const result =
            activeThreadIdRef.current === null
              ? await input.service.runTask(runOptions)
              : await input.service.continueThread(activeThreadIdRef.current, text, {
                  ...runOptions,
                  cwd: input.cwd,
                  taskId
                });
          flushPendingDelta();
          activeTaskIdRef.current = result.task.taskId;
          setActiveTaskId(result.task.taskId);
          activeThreadIdRef.current = result.task.threadId ?? null;
          setActiveThreadId(result.task.threadId ?? null);
          appendNewTraceEvents(result.task.taskId);

          const activeStreamId = streamingAgentIdRef.current;
          streamingAgentIdRef.current = null;

          const runError = result.error;
          if (runError !== undefined) {
            cancelPendingDelta();
            removeStreamingMessage(activeStreamId);
            setMessages((current) => [
              ...current,
              {
                code: runError.code,
                id: `error:${result.task.taskId}:${randomUUID()}`,
                kind: "error",
                message: runError.message,
                source: "runtime",
                timestamp: new Date().toISOString()
              }
            ]);
            setStatusLine(`failed: ${runError.code}`);
            setUiStatus({
              approvalLabel: null,
              primaryLabel: `failed: ${runError.code}`,
              primaryTone: "danger",
              runState: "failed",
              taskLabel: result.task.taskId.slice(0, 8)
            });
            return;
          }

          const messageText =
            result.output !== undefined && result.output !== null && result.output.length > 0
              ? result.output
              : summarizeTaskResult(result.task);
          if (activeStreamId !== null) {
            finalizeStreamingAgentMessage(activeStreamId, messageText);
          } else {
            setMessages((current) => [
              ...current,
              {
                id: `agent:${result.task.taskId}:${randomUUID()}`,
                kind: "agent",
                text: messageText,
                timestamp: new Date().toISOString()
              }
            ]);
          }
          setStatusLine(result.task.status);
          setUiStatus({
            approvalLabel: null,
            primaryLabel: result.task.status === "succeeded" ? "completed successfully" : result.task.status,
            primaryTone: result.task.status === "succeeded" ? "success" : "neutral",
            runState: result.task.status === "succeeded" ? "succeeded" : "idle",
            taskLabel: result.task.taskId.slice(0, 8)
          });
        } catch (error) {
          const activeStreamId = streamingAgentIdRef.current;
          streamingAgentIdRef.current = null;
          cancelPendingDelta();
          removeStreamingMessage(activeStreamId);

          const aborted = activeAbortControllerRef.current?.signal.aborted === true;

          if (aborted) {
            addSystemMessage("Interrupted current task.");
            setStatusLine("interrupted");
            setUiStatus({
              approvalLabel: null,
              primaryLabel: "interrupted",
              primaryTone: "warn",
              runState: "interrupted",
              taskLabel: activeTaskIdRef.current?.slice(0, 8) ?? null
            });
            return;
          }

          setMessages((current) => [
            ...current,
            {
              code: "runtime_error",
              id: `error:submit:${randomUUID()}`,
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
              source: "runtime",
              timestamp: new Date().toISOString()
            }
          ]);
          setStatusLine("failed to run task");
          setUiStatus({
            approvalLabel: null,
            primaryLabel: "failed to run task",
            primaryTone: "danger",
            runState: "failed",
            taskLabel: activeTaskIdRef.current?.slice(0, 8) ?? null
          });
        } finally {
          submitInFlightRef.current = false;
          activeAbortControllerRef.current = null;
          streamingAgentIdRef.current = null;
          streamedAnyRef.current = false;
          cancelPendingDelta();
          endBusy();
          stopTraceSubscription();
          setTimeout(refresh, 0);
        }
      })();

      return true;
    },
    [
      addSystemMessage,
      appendNewTraceEvents,
      beginBusy,
      cancelPendingDelta,
      endBusy,
      finalizeStreamingAgentMessage,
      flushPendingDelta,
      input.config,
      input.cwd,
      input.service,
      refresh,
      removeStreamingMessage,
      startTraceSubscription,
      stopTraceSubscription,
      upsertStreamingAgentMessage
    ]
  );

  const formatDiffSummary = React.useCallback((): string => {
    if (activeTaskIdRef.current !== null) {
      const artifacts = input.service
        .showTask(activeTaskIdRef.current)
        .artifacts.filter((artifact) => artifact.artifactType === "file");
      if (artifacts.length > 0) {
        return artifacts
          .map((artifact, index) => {
            const content = artifact.content;
            const path =
              typeof content === "object" && content !== null && !Array.isArray(content) && typeof content.path === "string"
                ? content.path
                : artifact.uri;
            const unifiedDiff =
              typeof content === "object" &&
              content !== null &&
              !Array.isArray(content) &&
              typeof content.unifiedDiff === "string"
                ? content.unifiedDiff
                : "";
            return [
              `${String(index + 1).padStart(2, " ")}. ${path}`,
              unifiedDiff.length === 0 ? "(no unified diff recorded)" : unifiedDiff
            ].join("\n");
          })
          .join("\n\n");
      }
    }

    if (fileEdits.length === 0) {
      return "No file_write operations recorded in this session yet.";
    }
    const lines = fileEdits.map((entry, index) => `${String(index + 1).padStart(2, " ")}. ${entry.path} (task ${entry.taskId.slice(0, 8)})`);
    return `Session file changes (${fileEdits.length}):\n${lines.join("\n")}`;
  }, [fileEdits, input.service]);

  const resolvePendingApproval = React.useCallback(
    async (action: "allow" | "deny") => {
      if (pendingApproval === null || approvalInFlightRef.current) {
        return;
      }

      approvalInFlightRef.current = true;
      beginBusy();
      const approval = pendingApproval;
      startTraceSubscription(approval.taskId);
      try {
        const result = await input.service.resolveApproval(approval.approvalId, action, input.reviewerId);
        appendNewTraceEvents(result.task.taskId);
        activeTaskIdRef.current = result.task.taskId;
        setActiveTaskId(result.task.taskId);
        setMessages((current) =>
          completeApprovalMessage(current, approval, action, seenApprovalMessageIdsRef.current)
        );
        const resultError = result.error;
        if (resultError !== undefined) {
          setMessages((current) => [
            ...current,
            {
              code: resultError.code,
              id: `error:approval-resume:${result.task.taskId}:${Date.now()}`,
              kind: "error",
              message: resultError.message,
              source: "runtime",
              timestamp: new Date().toISOString()
            }
          ]);
          setStatusLine(`failed after approval: ${resultError.code}`);
          setUiStatus({
            approvalLabel: approval.toolName,
            primaryLabel: `failed after ${action === "allow" ? "approval" : "denial"}`,
            primaryTone: "danger",
            runState: "failed",
            taskLabel: result.task.taskId.slice(0, 8)
          });
          return;
        }
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
        if (result.task.status === "waiting_approval") {
          setStatusLine("waiting_approval");
          setUiStatus({
            approvalLabel: approval.toolName,
            primaryLabel: `approval required: ${approval.toolName}`,
            primaryTone: "warn",
            runState: "waiting_approval",
            taskLabel: result.task.taskId.slice(0, 8)
          });
          return;
        }
        setStatusLine(`${action === "allow" ? "approved" : "denied"} ${approval.toolName}`);
        setUiStatus({
          approvalLabel: approval.toolName,
          primaryLabel: `${action === "allow" ? "approved" : "denied"} ${approval.toolName}`,
          primaryTone: action === "allow" ? "success" : "warn",
          runState: result.task.status === "succeeded" ? "succeeded" : "idle",
          taskLabel: result.task.taskId.slice(0, 8)
        });
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
        setUiStatus({
          approvalLabel: approval.toolName,
          primaryLabel: "approval failed",
          primaryTone: "danger",
          runState: "failed",
          taskLabel: approval.taskId.slice(0, 8)
        });
      } finally {
        approvalInFlightRef.current = false;
        endBusy();
        stopTraceSubscription();
        refresh();
      }
    },
    [
      appendNewTraceEvents,
      beginBusy,
      endBusy,
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
    activeThreadId,
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
    tokenHud,
    uiStatus
  };
}

export function syncPendingApprovalMessages(
  current: ChatMessage[],
  approvals: ApprovalRecord[],
  service: Pick<AgentApplicationService, "showTask">,
  seenIds: Set<string>
): ChatMessage[] {
  const approvalsByMessageId = new Map<string, ApprovalRecord>(
    approvals.map((approval) => [`approval:${approval.approvalId}`, approval] as const)
  );
  const retainedApprovalIds = new Set<string>();
  let changed = false;
  const next: ChatMessage[] = [];

  for (const message of current) {
    if (message.kind !== "approval") {
      next.push(message);
      continue;
    }

    const approval = approvalsByMessageId.get(message.id);
    if (approval === undefined) {
      seenIds.delete(message.id);
      changed = true;
      continue;
    }

    if (retainedApprovalIds.has(message.id)) {
      changed = true;
      continue;
    }

    if (message.status === "pending") {
      next.push(message);
    } else {
      const toolCall = findToolCall(service, approval);
      next.push(toApprovalMessage(approval, toolCall));
      changed = true;
    }
    retainedApprovalIds.add(message.id);
    seenIds.add(message.id);
  }

  for (const approval of approvals) {
    const messageId = `approval:${approval.approvalId}`;
    if (retainedApprovalIds.has(messageId)) {
      continue;
    }

    const toolCall = findToolCall(service, approval);
    next.push(toApprovalMessage(approval, toolCall));
    seenIds.add(messageId);
    changed = true;
  }

  return changed ? next : current;
}

export function completeApprovalMessage(
  current: ChatMessage[],
  approval: ApprovalRecord,
  action: "allow" | "deny",
  seenIds: Set<string>
): ChatMessage[] {
  const approvalMessageId = `approval:${approval.approvalId}`;
  const resultMessageId = `approval-result:${approval.approvalId}:${action}`;
  let removedApproval = false;
  let hasResult = false;
  const next: ChatMessage[] = [];

  for (const message of current) {
    if (message.id === resultMessageId) {
      hasResult = true;
      next.push(message);
      continue;
    }
    if (message.kind === "approval" && message.approval.approvalId === approval.approvalId) {
      removedApproval = true;
      continue;
    }
    next.push(message);
  }

  seenIds.delete(approvalMessageId);

  if (!hasResult) {
    next.push(toApprovalResultMessage(approval, action));
  }

  return removedApproval || !hasResult ? next : current;
}

function collectApprovalMessageIds(messages: ChatMessage[]): Set<string> {
  return new Set(
    messages
      .filter((message): message is Extract<ChatMessage, { kind: "approval" }> => message.kind === "approval")
      .map((message) => message.id)
  );
}

function summaryEquals(left: ChatController["summary"], right: ChatController["summary"]): boolean {
  return (
    left.pendingApprovals === right.pendingApprovals &&
    left.runningTasks === right.runningTasks &&
    left.tasks === right.tasks
  );
}

function approvalRefEquals(left: ApprovalRecord | null, right: ApprovalRecord | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.approvalId === right.approvalId &&
    left.status === right.status &&
    left.taskId === right.taskId &&
    left.toolCallId === right.toolCallId
  );
}

function tokenHudEquals(left: TokenHud, right: TokenHud): boolean {
  return (
    left.contextPercent === right.contextPercent &&
    left.estimatedCostUsd === right.estimatedCostUsd &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens
  );
}

function updateUiStatus(
  setUiStatus: React.Dispatch<React.SetStateAction<UiStatus>>,
  next: UiStatus
): void {
  setUiStatus((current) => (uiStatusEquals(current, next) ? current : next));
}

function uiStatusEquals(left: UiStatus, right: UiStatus): boolean {
  return (
    left.approvalLabel === right.approvalLabel &&
    left.primaryLabel === right.primaryLabel &&
    left.primaryTone === right.primaryTone &&
    left.runState === right.runState &&
    left.taskLabel === right.taskLabel
  );
}

function findToolCall(
  service: Pick<AgentApplicationService, "showTask">,
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

import React from "react";

import { createDefaultRunOptions, type AgentApplicationService, type AppConfig } from "../../runtime";
import type { ApprovalRecord, TaskRecord, ToolCallRecord, TraceEvent } from "../../types";
import {
  resolveApprovalMessage,
  toApprovalMessage,
  toTraceActivityMessage,
  type ChatMessage
} from "../view-models/chat-messages";

export interface UseChatControllerOptions {
  config: AppConfig;
  cwd: string;
  reviewerId: string;
  service: AgentApplicationService;
}

export interface ChatController {
  addSystemMessage: (text: string) => void;
  busy: boolean;
  clearConversation: () => void;
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
}

export function useChatController(input: UseChatControllerOptions): ChatController {
  const [messages, setMessages] = React.useState<ChatMessage[]>(() => [
    {
      id: "system:welcome",
      kind: "system",
      text: "Welcome to auto-talon chat mode. Type a prompt and press Meta+Enter to send.",
      timestamp: new Date().toISOString()
    }
  ]);
  const [busy, setBusy] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState("idle");
  const [summary, setSummary] = React.useState({
    pendingApprovals: 0,
    runningTasks: 0,
    tasks: 0
  });
  const [pendingApproval, setPendingApproval] = React.useState<ApprovalRecord | null>(null);
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
    setMessages([
      {
        id: "system:welcome",
        kind: "system",
        text: "Welcome to auto-talon chat mode. Type a prompt and press Meta+Enter to send.",
        timestamp: new Date().toISOString()
      }
    ]);
    setStatusLine("conversation cleared");
  }, []);

  const startedAtRef = React.useRef(Date.now());
  const activeAbortControllerRef = React.useRef<AbortController | null>(null);
  const activeTaskIdRef = React.useRef<string | null>(null);
  const lastSequenceByTaskRef = React.useRef<Record<string, number>>({});
  const seenApprovalMessageIdsRef = React.useRef<Set<string>>(new Set());

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
    } catch (error) {
      setStatusLine(error instanceof Error ? `refresh failed: ${error.message}` : "refresh failed");
    }
  }, [input.service]);

  React.useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1_000);
    return () => {
      clearInterval(interval);
    };
  }, [refresh]);

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
    },
    [input.service]
  );

  const submitPrompt = React.useCallback(
    async (text: string) => {
      setBusy(true);
      setStatusLine("running");
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
        const result = await input.service.runTask(runOptions);
        activeTaskIdRef.current = result.task.taskId;
        appendNewTraceEvents(result.task.taskId);

        if (result.error !== undefined) {
          setMessages((current) => [
            ...current,
            {
              code: result.error.code,
              id: `error:${result.task.taskId}:${Date.now()}`,
              kind: "error",
              message: result.error.message,
              source: "runtime",
              timestamp: new Date().toISOString()
            }
          ]);
          setStatusLine(`failed: ${result.error.code}`);
          return;
        }

        const messageText = result.output ?? summarizeTaskResult(result.task);
        setMessages((current) => [
          ...current,
          {
            id: `agent:${result.task.taskId}:${Date.now()}`,
            kind: "agent",
            text: messageText,
            timestamp: new Date().toISOString()
          }
        ]);
        setStatusLine(result.task.status);
      } catch (error) {
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
        setBusy(false);
        refresh();
      }
    },
    [addSystemMessage, appendNewTraceEvents, input.config, input.cwd, input.service, refresh]
  );

  const resolvePendingApproval = React.useCallback(
    async (action: "allow" | "deny") => {
      if (pendingApproval === null || busy) {
        return;
      }

      setBusy(true);
      try {
        const result = await input.service.resolveApproval(pendingApproval.approvalId, action, input.reviewerId);
        appendNewTraceEvents(result.task.taskId);
        activeTaskIdRef.current = result.task.taskId;
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
              text: result.output,
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
        refresh();
      }
    },
    [appendNewTraceEvents, busy, input.reviewerId, input.service, pendingApproval, refresh]
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
    addSystemMessage,
    busy,
    clearConversation,
    hasPendingApproval: pendingApproval !== null,
    messages,
    pendingApproval,
    requestInterrupt,
    resolvePendingApproval,
    runDurationLabel,
    statusLine,
    submitPrompt,
    summary
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

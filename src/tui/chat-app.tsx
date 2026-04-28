import { randomUUID } from "node:crypto";
import React from "react";
import { Box, Text, useApp } from "ink";

import type { AgentApplicationService, AppConfig } from "../runtime/index.js";
import { parseNaturalLanguageScheduleWhen } from "../runtime/scheduler/index.js";
import type { ApprovalAllowScope } from "../types/index.js";
import { formatMemoryGuide, formatMemoryList, formatMemoryRecallExplanation, formatMemorySuggestionQueue } from "../cli/formatters.js";
import { Banner } from "./components/banner.js";
import { InputBox } from "./components/input-box.js";
import { MessageStream, StaticMessageStream } from "./components/message-stream.js";
import { PromptZone } from "./components/prompt-zone.js";
import { buildTokenMetrics, StatusBar } from "./components/status-bar.js";
import { editInExternalEditor } from "./external-editor.js";
import { useChatController } from "./hooks/use-chat-controller.js";
import { useTextInput } from "./hooks/use-text-input.js";
import { listSessionIds, saveSession } from "./session-store.js";
import {
  STATIC_SLASH_SUGGESTIONS,
  completeSlashCommand,
  getMatchingSuggestions,
  longestCommonPrefix,
  type SlashSuggestion
} from "./slash-commands.js";
import { theme } from "./theme.js";
import { displayChatMessages, type ChatMessage } from "./view-models/chat-messages.js";
import {
  buildTodaySummary,
  formatThreadDetailForTui,
  formatTodaySummary,
  resolveRuntimeUserId
} from "./view-models/today-summary.js";

export interface ChatTuiAppProps {
  config: AppConfig;
  cwd: string;
  initialMessages?: ChatMessage[];
  initialSessionApprovalFingerprints?: string[];
  initialSessionId: string;
  initialThreadId?: string;
  reviewerId: string;
  service: AgentApplicationService;
}

interface ScheduleCommandController {
  activeThreadId: string | null;
  addSystemMessage: (text: string) => void;
}

interface ScheduleCommandOptions {
  cwd: string;
  providerName: string;
}

export function ChatTuiApp({
  config,
  cwd,
  initialMessages,
  initialSessionApprovalFingerprints,
  initialSessionId,
  initialThreadId,
  reviewerId,
  service
}: ChatTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const [sessionTitle, setSessionTitle] = React.useState("assistant");
  const [sessionId, setSessionId] = React.useState(initialSessionId);
  const [approvalSelectionIndex, setApprovalSelectionIndex] = React.useState(0);
  const [clarifySelectionIndex, setClarifySelectionIndex] = React.useState(0);
  const [clarifyCustomActive, setClarifyCustomActive] = React.useState(false);
  const [liveScrollOffset, setLiveScrollOffset] = React.useState(0);
  const historyRef = React.useRef<string[]>([]);
  const historyIndexRef = React.useRef<number | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionStateRef = React.useRef<{ candidates: string[]; index: number; query: string } | null>(null);

  const controller = useChatController({
    config,
    cwd,
    ...(initialMessages !== undefined ? { initialMessages } : {}),
    ...(initialSessionApprovalFingerprints !== undefined
      ? { initialSessionApprovalFingerprints }
      : {}),
    ...(initialThreadId !== undefined ? { initialThreadId } : {}),
    reviewerId,
    service
  });

  const displayMessages = React.useMemo(
    () => displayChatMessages(controller.messages),
    [controller.messages]
  );
  const staticMessages = React.useMemo(
    () => displayMessages.filter((message) => !isLiveTranscriptMessage(message)),
    [displayMessages]
  );
  const liveMessages = React.useMemo(
    () => displayMessages.filter(isLiveTranscriptMessage),
    [displayMessages]
  );
  const visibleLiveMessages = React.useMemo(() => {
    if (liveMessages.length <= LIVE_TRANSCRIPT_WINDOW_SIZE) {
      return liveMessages;
    }
    const maxOffset = Math.max(liveMessages.length - LIVE_TRANSCRIPT_WINDOW_SIZE, 0);
    const boundedOffset = Math.min(liveScrollOffset, maxOffset);
    const end = liveMessages.length - boundedOffset;
    const start = Math.max(0, end - LIVE_TRANSCRIPT_WINDOW_SIZE);
    return liveMessages.slice(start, end);
  }, [liveMessages, liveScrollOffset]);
  const todaySummaryText = React.useMemo(
    () => formatTodaySummary(buildTodaySummary(service, { activeThreadId: controller.activeThreadId })),
    [controller.activeThreadId, service]
  );
  const showTodaySummary = React.useMemo(
    () => isEmptyConversation(controller.messages),
    [controller.messages]
  );

  React.useEffect(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    if (controller.busy) {
      return;
    }
    saveTimerRef.current = setTimeout(() => {
      void saveSession(config.workspaceRoot, {
        id: sessionId,
        messages: controller.messages,
        sessionApprovalFingerprints: controller.sessionApprovalFingerprints,
        ...(controller.activeThreadId !== null ? { threadId: controller.activeThreadId } : {}),
        updatedAt: new Date().toISOString()
      });
    }, 600);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [config.workspaceRoot, controller.activeThreadId, controller.busy, controller.messages, controller.sessionApprovalFingerprints, sessionId]);

  React.useEffect(() => {
    if (controller.pendingApproval !== null) {
      setApprovalSelectionIndex(0);
    }
  }, [controller.pendingApproval?.approvalId]);

  React.useEffect(() => {
    if (controller.pendingClarifyPrompt !== null) {
      setClarifySelectionIndex(0);
      setClarifyCustomActive(false);
    }
  }, [controller.pendingClarifyPrompt?.promptId]);

  React.useEffect(() => {
    setLiveScrollOffset(0);
  }, [liveMessages.length]);

  const navigateHistoryPrevious = React.useCallback((): string | null => {
    const history = historyRef.current;
    if (history.length === 0) {
      return null;
    }
    if (historyIndexRef.current === null) {
      historyIndexRef.current = history.length - 1;
      return history[historyIndexRef.current] ?? null;
    }
    historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
    return history[historyIndexRef.current] ?? null;
  }, []);

  const navigateHistoryNext = React.useCallback((): string | null => {
    const history = historyRef.current;
    if (history.length === 0 || historyIndexRef.current === null) {
      return "";
    }
    historyIndexRef.current = Math.min(history.length, historyIndexRef.current + 1);
    if (historyIndexRef.current === history.length) {
      historyIndexRef.current = null;
      return "";
    }
    return history[historyIndexRef.current] ?? "";
  }, []);

  const openExternalEditor = React.useCallback(
    async (value: string): Promise<string> =>
      editInExternalEditor(value, {
        workspaceRoot: config.workspaceRoot
      }),
    [config.workspaceRoot]
  );

  const scrollLiveTranscript = React.useCallback((direction: -1 | 1, accelerated: boolean) => {
    const delta = accelerated ? LIVE_TRANSCRIPT_PAGE_SIZE * 2 : LIVE_TRANSCRIPT_PAGE_SIZE;
    setLiveScrollOffset((current) => Math.max(0, current + (direction < 0 ? delta : -delta)));
  }, []);

  const jumpLiveTranscript = React.useCallback(
    (target: "start" | "end") => {
      if (target === "end") {
        setLiveScrollOffset(0);
        return;
      }
      setLiveScrollOffset(Math.max(liveMessages.length - LIVE_TRANSCRIPT_WINDOW_SIZE, 0));
    },
    [liveMessages.length]
  );

  const slashSuggestions = React.useCallback(
    (value: string): SlashSuggestion[] => {
      if (!value.startsWith("/")) {
        return [];
      }
      const dynamicSuggestions = buildDynamicSlashSuggestions(value, controller.activeThreadId, service);
      return getMatchingSuggestions(value, [...STATIC_SLASH_SUGGESTIONS, ...dynamicSuggestions]);
    },
    [controller.activeThreadId, service]
  );

  const completeInput = React.useCallback(
    (value: string): string | null => {
      const suggestions = slashSuggestions(value);
      if (suggestions.length === 0) {
        completionStateRef.current = null;
        return completeSlashCommand(value);
      }
      const candidates = suggestions.map((item) => item.insertText);
      const previous = completionStateRef.current;
      if (
        previous !== null &&
        previous.query === value &&
        previous.candidates.length === candidates.length &&
        previous.candidates.every((candidate, index) => candidate === candidates[index])
      ) {
        const index = (previous.index + 1) % candidates.length;
        completionStateRef.current = { candidates, index, query: withTrailingSpace(candidates[index] ?? value) };
        return withTrailingSpace(candidates[index] ?? value);
      }
      const common = longestCommonPrefix(candidates);
      const nextValue =
        common.length > value.length
          ? withTrailingSpaceIfExact(common, candidates)
          : withTrailingSpace(candidates[0] ?? value);
      completionStateRef.current = { candidates, index: 0, query: nextValue };
      return nextValue;
    },
    [slashSuggestions]
  );

  const handleSlashCommand = React.useCallback(
    (text: string): boolean => {
      if (!text.startsWith("/")) {
        return false;
      }

      if (text === "/help") {
        controller.addSystemMessage(
          [
            "Commands: /today /inbox /thread [summary|list|new|switch] /next [list|done|block] /commitments [list|done|block] /schedule /edit /help /ops /status /clear /new /stop /history /context /cost /diff /sandbox /sessions /rollback <id|last> /title <name>",
            "Memory: /memory /memory review /memory add <profile|project> <text> /memory forget <memory-id-prefix> /memory why [memory-id-prefix]",
            "Compatibility: /dashboard remains available and maps to /ops.",
            "Tip: use `talon ops` or `talon tui --mode ops` for the observability view.",
            "Shortcuts: Enter send | Alt+Enter / Ctrl+J newline | Ctrl+Shift+V paste | Ctrl+O external editor | Alt+P expand pasted draft | Tab slash-complete | Ctrl+P/N history | PgUp/PgDn live scroll",
            "Session files: .auto-talon/sessions/<id>.json | resume: talon tui --resume <id>",
            "Token pricing estimate: AGENT_TOKEN_PRICE_IN_PER_M / AGENT_TOKEN_PRICE_OUT_PER_M (optional)",
            "Transcript keeps terminal scrollback for native copy/mouse wheel; PgUp/PgDn accelerates the live area."
          ].join("\n")
        );
        return true;
      }

      if (text === "/today") {
        controller.addSystemMessage(todaySummaryText);
        return true;
      }

      if (text === "/inbox") {
        const userId = resolveRuntimeUserId();
        const items = service
          .listInbox({ status: "pending", userId })
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 20);
        controller.addSystemMessage(
          items.length === 0
            ? `Inbox pending (user=${userId}): none`
            : `Inbox pending (user=${userId}, showing ${items.length}):\n${items
                .map((item) => `- ${item.inboxId.slice(0, 8)} | ${item.title} [${item.status}]`)
                .join("\n")}`
        );
        return true;
      }

      if (text.startsWith("/thread")) {
        return handleThreadCommand(text, controller, service);
      }

      if (text.startsWith("/next")) {
        return handleNextActionCommand(text, controller, service);
      }

      if (text.startsWith("/commitments")) {
        return handleCommitmentCommand(text, controller, service);
      }

      if (text.startsWith("/memory")) {
        return handleMemoryCommand(text, controller, service, cwd, config.defaultProfileId, reviewerId);
      }

      if (text === "/schedule") {
        return handleScheduleCommand(text, controller, service, {
          cwd,
          providerName: config.provider.name
        });
      }

      if (text.startsWith("/schedule")) {
        return handleScheduleCommand(text, controller, service, {
          cwd,
          providerName: config.provider.name
        });
      }

      if (text === "/ops") {
        controller.addSystemMessage("Open ops with: talon ops (or talon tui --mode ops).");
        return true;
      }

      if (text === "/edit") {
        return false;
      }

      if (text === "/clear") {
        controller.clearConversation();
        return true;
      }

      if (text === "/new") {
        controller.clearConversation();
        setSessionTitle("assistant");
        const nextId = randomUUID();
        setSessionId(nextId);
        controller.addSystemMessage(`Started a new assistant session. id=${nextId}`);
        return true;
      }

      if (text === "/stop") {
        const requested = controller.requestInterrupt();
        controller.addSystemMessage(requested ? "Stop requested for current task." : "No running task to stop.");
        return true;
      }

      if (text === "/history") {
        const items = historyRef.current.slice(-20);
        if (items.length === 0) {
          controller.addSystemMessage("No prompt history yet.");
          return true;
        }
        const lines = items
          .map((line, index) => `${String(index + 1).padStart(2, " ")}. ${line.replace(/\n/gu, " ")}`)
          .join("\n");
        controller.addSystemMessage(`Recent prompts (last ${items.length}):\n${lines}`);
        return true;
      }

      if (text === "/cost") {
        const u = controller.tokenHud;
        controller.addSystemMessage(
          `Session token estimate (provider telemetry): in=${u.inputTokens} out=${u.outputTokens} | ~$${u.estimatedCostUsd.toFixed(4)}`
        );
        return true;
      }

      if (text === "/context") {
        const b = config.tokenBudget;
        controller.addSystemMessage(
          [
            `Context vs configured budget: ${controller.tokenHud.contextPercent}% of ~${b.inputLimit + b.outputLimit} tokens (inputLimit=${b.inputLimit} outputLimit=${b.outputLimit}).`,
            `Used (telemetry): input=${controller.tokenHud.inputTokens} output=${controller.tokenHud.outputTokens}`
          ].join("\n")
        );
        return true;
      }

      if (text === "/diff") {
        controller.addSystemMessage(controller.formatDiffSummary());
        return true;
      }

      if (text === "/sessions") {
        void listSessionIds(config.workspaceRoot).then((ids) => {
          controller.addSystemMessage(
            ids.length > 0 ? `Saved session ids (newest files under .auto-talon/sessions):\n${ids.join("\n")}` : "No saved sessions yet."
          );
        });
        return true;
      }

      if (text === "/dashboard") {
        controller.addSystemMessage("`/dashboard` is a compatibility alias. Use /ops, talon ops, or talon tui --mode ops.");
        return true;
      }

      if (text === "/status") {
        const lines = [
          `session: ${sessionTitle}`,
          `session_id: ${sessionId}`,
          `cwd: ${cwd}`,
          `sandbox_mode: ${config.sandbox.mode}`,
          `write_roots: ${config.sandbox.writeRoots.join(", ")}`,
          `model: ${config.provider.model ?? config.provider.name}`,
          `provider: ${config.provider.name}`,
          `reviewer: ${reviewerId}`,
          `thread: ${controller.activeThreadId ?? "(none)"}`,
          `busy: ${controller.busy}`,
          `active_task: ${controller.activeTaskId ?? "(none)"}`,
          `tasks: ${controller.summary.tasks} running: ${controller.summary.runningTasks} approvals: ${controller.summary.pendingApprovals}`,
          `queued_prompts: ${controller.queuedPromptCount}`,
          `status_line: ${controller.statusLine}`,
          `ui_status: ${controller.uiStatus.primaryLabel}`,
          `elapsed: ${controller.runDurationLabel}`,
          `ui_scroll: terminal + live(offset=${liveScrollOffset})`,
          `message_rows: ${controller.messages.length}`,
          `tokens_in: ${controller.tokenHud.inputTokens} tokens_out: ${controller.tokenHud.outputTokens}`,
          `context_pct: ${controller.tokenHud.contextPercent} est_cost_usd: ${controller.tokenHud.estimatedCostUsd.toFixed(4)}`
        ];
        controller.addSystemMessage(lines.join("\n"));
        return true;
      }

      if (text === "/sandbox") {
        const sandbox = config.sandbox;
        controller.addSystemMessage(
          [
            `sandbox_mode: ${sandbox.mode}`,
            `sandbox_profile: ${sandbox.profileName ?? "(default)"}`,
            `sandbox_source: ${sandbox.configSource}`,
            `workspace: ${sandbox.workspaceRoot}`,
            `write_roots: ${sandbox.writeRoots.join(", ")}`,
            `read_roots: ${sandbox.readRoots.join(", ")}`
          ].join("\n")
        );
        return true;
      }

      if (text.startsWith("/rollback ")) {
        const artifactId = text.slice("/rollback ".length).trim();
        if (artifactId.length === 0) {
          controller.addSystemMessage("Usage: /rollback last|<artifact_id>");
          return true;
        }

        void service
          .rollbackFileArtifact(artifactId)
          .then((result) => {
            controller.addSystemMessage(
              result.deleted
                ? `Rolled back by deleting ${result.path}`
                : `Rolled back by restoring ${result.path}`
            );
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            controller.addSystemMessage(`Rollback failed: ${message}`);
          });
        return true;
      }

      if (text.startsWith("/title ")) {
        const nextTitle = text.slice("/title ".length).trim();
        if (nextTitle.length === 0) {
          controller.addSystemMessage("Usage: /title <name>");
          return true;
        }
        setSessionTitle(nextTitle);
        controller.addSystemMessage(`Session title set to: ${nextTitle}`);
        return true;
      }

      controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
      return true;
    },
    [
      config.provider.model,
      config.provider.name,
      config.sandbox,
      config.tokenBudget,
      config.workspaceRoot,
      controller,
      cwd,
      reviewerId,
      service,
      sessionId,
      sessionTitle
    ]
  );

  const activePrompt =
    controller.pendingClarifyPrompt !== null
      ? {
          kind: "clarify" as const,
          customActive: clarifyCustomActive,
          optionCount: controller.pendingClarifyPrompt.options.length
        }
      : controller.pendingApproval !== null
        ? { kind: "approval" as const }
        : undefined;

  const textInput = useTextInput({
    ...(activePrompt !== undefined ? { activePrompt } : {}),
    busy: controller.busy,
    hasPendingApproval: controller.hasPendingApproval,
    onHistoryNext: navigateHistoryNext,
    onHistoryPrevious: navigateHistoryPrevious,
    onImagePasteAttempt: () => {
      controller.addSystemMessage(
        "Image paste (Alt+V): multimodal clipboard is not wired to providers in this build. Add an image path or use a vision-capable flow outside the TUI."
      );
    },
    onInterruptRequest: () => {
      const requested = controller.requestInterrupt();
      controller.addSystemMessage(
        requested
          ? "Interrupt requested. Press Ctrl+C again within 2s to force exit if shutdown is needed."
          : "No running task to interrupt."
      );
    },
    onApprovalAction: (action) => {
      void controller.resolvePendingApproval(action);
    },
    onExit: exit,
    onPromptCtrlC: () => {
      if (controller.pendingClarifyPrompt !== null) {
        controller.cancelPendingClarifyPrompt();
        return;
      }
      if (controller.pendingApproval !== null) {
        void controller.resolvePendingApproval("deny");
      }
    },
    onPromptMove: (delta) => {
      if (controller.pendingApproval !== null) {
        setApprovalSelectionIndex((current) => clampSelection(current + delta, APPROVAL_ACTIONS.length));
        return;
      }
      if (controller.pendingClarifyPrompt !== null && !clarifyCustomActive) {
        setClarifySelectionIndex((current) =>
          clampSelection(current + delta, controller.pendingClarifyPrompt!.options.length)
        );
      }
    },
    onPromptShortcut: (index) => {
      const action = APPROVAL_ACTIONS[index];
      if (action !== undefined) {
        void controller.resolvePendingApproval(action.action, action.scope);
      }
    },
    onPromptSubmit: (value) => {
      if (controller.pendingApproval !== null) {
        const action = APPROVAL_ACTIONS[approvalSelectionIndex] ?? APPROVAL_ACTIONS[0];
        if (action !== undefined) {
          void controller.resolvePendingApproval(action.action, action.scope);
        }
        return;
      }
      if (controller.pendingClarifyPrompt !== null) {
        if (clarifyCustomActive) {
          const answerText = value.trim();
          if (answerText.length > 0) {
            void controller.answerPendingClarifyPrompt({ answerText });
          }
          return;
        }
        const option = controller.pendingClarifyPrompt.options[clarifySelectionIndex];
        if (option !== undefined) {
          void controller.answerPendingClarifyPrompt({ answerOptionId: option.id });
        }
      }
    },
    onPromptTab: () => {
      if (controller.pendingClarifyPrompt?.allowCustomAnswer !== true) {
        return;
      }
      setClarifyCustomActive((current) => !current);
    },
    onExternalEditorEdit: openExternalEditor,
    onPageJump: jumpLiveTranscript,
    onPageScroll: scrollLiveTranscript,
    onTabComplete: completeInput,
    onSubmit: (value) => {
      if (value.trim() === "/edit") {
        void openExternalEditor("");
        return true;
      }
      if (controller.busy && value.startsWith("/") && value.trim() !== "/stop") {
        controller.addSystemMessage("Commands are paused while the agent is running. Wait, queue plain text, or use /stop.");
        return false;
      }
      if (handleSlashCommand(value)) {
        return true;
      }
      const accepted = controller.submitPrompt(value);
      if (!accepted) {
        return false;
      }
      historyRef.current.push(value);
      if (historyRef.current.length > 200) {
        historyRef.current = historyRef.current.slice(-200);
      }
      historyIndexRef.current = null;
      return true;
    },
    onSubmitBlockedBusy: () => {
      controller.addSystemMessage("Agent is still running. Wait for completion or use /stop to interrupt.");
    }
  });

  const slashHints = textInput.value.startsWith("/") && textInput.value.length > 0 ? slashSuggestions(textInput.value) : [];

  React.useEffect(() => {
    if (controller.pendingApproval !== null || controller.pendingClarifyPrompt !== null) {
      textInput.clearValue();
    }
  }, [controller.pendingApproval?.approvalId, controller.pendingClarifyPrompt?.promptId]);

  return (
    <Box flexDirection="column">
      <StaticMessageStream messages={staticMessages} />
      <Banner
        details={[config.provider.model ?? config.provider.name, shortenPath(cwd, 20)]}
        productName="AUTOTALON"
        title={sessionTitle === "assistant" ? "Personal Assistant" : sessionTitle}
      />
      <Box flexDirection="column">
        {liveMessages.length > 0 ? (
          <MessageStream messages={visibleLiveMessages} />
        ) : showTodaySummary ? (
          <Text color={theme.muted}>{todaySummaryText}</Text>
        ) : staticMessages.length === 0 ? (
          <Text color={theme.muted}>No conversation yet.</Text>
        ) : null}
      </Box>
      <PromptZone
        approvalPrompt={
          controller.pendingApproval === null
            ? null
            : {
                approval: controller.pendingApproval,
                selectedIndex: approvalSelectionIndex,
                toolCall:
                  service
                    .showTask(controller.pendingApproval.taskId)
                    .toolCalls.find((item) => item.toolCallId === controller.pendingApproval?.toolCallId) ?? null
              }
        }
        clarifyPrompt={
          controller.pendingClarifyPrompt === null
            ? null
            : {
                customActive: clarifyCustomActive,
                customLines: textInput.lines,
                prompt: controller.pendingClarifyPrompt,
                selectedIndex: clarifySelectionIndex
              }
        }
      />
      <Box>
        {controller.pendingApproval === null && controller.pendingClarifyPrompt === null ? (
          <InputBox
            busy={controller.busy}
            collapsePreview={textInput.collapsePreview}
            hasPendingApproval={controller.hasPendingApproval}
            isCollapsed={textInput.isCollapsed}
            lines={textInput.lines}
            queuedPromptCount={controller.queuedPromptCount}
            slashHints={slashHints}
            value={textInput.value}
          />
        ) : null}
      </Box>
      <Box>
        <StatusBar
          details={[`elapsed ${controller.runDurationLabel}`]}
          hints={[
            controller.pendingClarifyPrompt !== null
              ? "Arrows choose, Tab custom, Enter submit"
              : controller.hasPendingApproval
                ? "1 once, 2 session, 3 always, 4 deny"
                : "Enter send"
          ]}
          metrics={buildTokenMetrics(
            controller.tokenHud.inputTokens,
            controller.tokenHud.outputTokens,
            controller.tokenHud.contextPercent,
            controller.tokenHud.estimatedCostUsd
          ).concat(
            controller.usedMemoryCount > 0
              ? [{ label: `Used memory ${controller.usedMemoryCount}`, tone: "accent" as const }]
              : []
          )}
          primary={{
            label: controller.uiStatus.primaryLabel,
            tone: controller.uiStatus.primaryTone
          }}
        />
      </Box>
    </Box>
  );
}

function shortenPath(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `...${value.slice(-(maxLength - 3))}`;
}

const APPROVAL_ACTIONS: Array<{ action: "allow" | "deny"; scope?: ApprovalAllowScope }> = [
  { action: "allow", scope: "once" },
  { action: "allow", scope: "session" },
  { action: "allow", scope: "always" },
  { action: "deny" }
];
const LIVE_TRANSCRIPT_WINDOW_SIZE = 12;
const LIVE_TRANSCRIPT_PAGE_SIZE = 6;

function clampSelection(index: number, size: number): number {
  if (size <= 0) {
    return 0;
  }
  if (index < 0) {
    return size - 1;
  }
  if (index >= size) {
    return 0;
  }
  return index;
}

function isLiveTranscriptMessage(message: ChatMessage): boolean {
  return (
    (message.kind === "agent" && message.streaming === true) ||
    (message.kind === "approval" && message.status === "pending")
  );
}

function isEmptyConversation(messages: ChatMessage[]): boolean {
  return !messages.some((message) => message.kind === "user" || message.kind === "agent");
}

function parseSlashInput(text: string): { args: string[]; command: string; rest: string } {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/u).filter((part) => part.length > 0);
  const command = parts[0] ?? "";
  const args = parts.slice(1);
  const rest = command.length >= trimmed.length ? "" : trimmed.slice(command.length).trim();
  return { args, command, rest };
}

function buildDynamicSlashSuggestions(
  value: string,
  activeThreadId: string | null,
  service: AgentApplicationService
): SlashSuggestion[] {
  const parsed = parseSlashInput(value);
  const userId = resolveRuntimeUserId();

  if (parsed.command === "/thread" && (parsed.args[0] === "switch" || parsed.args[0] === "summary")) {
    return service
      .listThreads("active")
      .filter((item) => item.ownerUserId === userId)
      .map((item) => ({
        description: item.title,
        insertText: `/thread ${parsed.args[0]} ${item.threadId.slice(0, 8)}`,
        key: `thread:${item.threadId}`,
        label: `/thread ${parsed.args[0]} ${item.threadId.slice(0, 8)}`,
        rank: 1
      }));
  }

  if (parsed.command === "/schedule" && (parsed.args[0] === "pause" || parsed.args[0] === "resume")) {
    return service.listSchedules({ ownerUserId: userId }).map((item) => ({
      description: item.name,
      insertText: `/schedule ${parsed.args[0]} ${item.scheduleId.slice(0, 8)}`,
      key: `schedule:${item.scheduleId}`,
      label: `/schedule ${parsed.args[0]} ${item.scheduleId.slice(0, 8)}`,
      rank: 1
    }));
  }

  if (parsed.command === "/memory" && (parsed.args[0] === "forget" || parsed.args[0] === "why")) {
    return service.listMemories().map((item) => ({
      description: item.title,
      insertText: `/memory ${parsed.args[0]} ${item.memoryId}`,
      key: `memory:${item.memoryId}`,
      label: `/memory ${parsed.args[0]} ${item.memoryId}`,
      rank: 1
    }));
  }

  if (parsed.command === "/next" && (parsed.args[0] === "done" || parsed.args[0] === "block")) {
    const items = activeThreadId === null ? service.listNextActions() : service.listNextActions({ threadId: activeThreadId });
    return items.map((item) => ({
      description: item.title,
      insertText: `/next ${parsed.args[0]} ${item.nextActionId.slice(0, 8)}`,
      key: `next:${item.nextActionId}`,
      label: `/next ${parsed.args[0]} ${item.nextActionId.slice(0, 8)}`,
      rank: 1
    }));
  }

  if (parsed.command === "/commitments" && (parsed.args[0] === "done" || parsed.args[0] === "block")) {
    const items = activeThreadId === null ? service.listCommitments() : service.listCommitments({ threadId: activeThreadId });
    return items.map((item) => ({
      description: item.title,
      insertText: `/commitments ${parsed.args[0]} ${item.commitmentId.slice(0, 8)}`,
      key: `commitment:${item.commitmentId}`,
      label: `/commitments ${parsed.args[0]} ${item.commitmentId.slice(0, 8)}`,
      rank: 1
    }));
  }

  return [];
}

function withTrailingSpace(value: string): string {
  return value.endsWith(" ") ? value : `${value} `;
}

function withTrailingSpaceIfExact(prefix: string, candidates: readonly string[]): string {
  return candidates.includes(prefix) ? withTrailingSpace(prefix) : prefix;
}

function handleMemoryCommand(
  text: string,
  controller: ReturnType<typeof useChatController>,
  service: AgentApplicationService,
  cwd: string,
  profileId: string,
  reviewerId: string
): boolean {
  const parsed = parseSlashInput(text);
  if (parsed.command !== "/memory") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = parsed.args[0] ?? "";
  if (sub.length === 0) {
    const guidance = [formatMemoryGuide()];
    if (controller.activeTaskId !== null) {
      guidance.push(
        formatMemoryRecallExplanation(service.explainMemoryRecall(controller.activeTaskId))
      );
    }
    controller.addSystemMessage(guidance.join("\n\n"));
    return true;
  }
  if (sub === "review") {
    const items = service.listMemorySuggestions({
      limit: 20,
      status: "pending",
      userId: resolveRuntimeUserId()
    });
    controller.addSystemMessage(formatMemorySuggestionQueue(items));
    return true;
  }
  if (sub === "add") {
    const scope = parsed.args[1];
    const content = parsed.args.slice(2).join(" ").trim();
    if ((scope !== "profile" && scope !== "project") || content.length === 0) {
      controller.addSystemMessage("Usage: /memory add <profile|project> <text>");
      return true;
    }
    try {
      const memory = service.addMemory({
        content,
        cwd,
        profileId,
        reviewerId,
        scope,
        userId: resolveRuntimeUserId()
      });
      controller.addSystemMessage(formatMemoryList([memory]));
    } catch (error) {
      controller.addSystemMessage(error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (sub === "forget") {
    const prefix = parsed.args[1] ?? "";
    if (prefix.length === 0) {
      controller.addSystemMessage("Usage: /memory forget <memory-id-prefix>");
      return true;
    }
    const matches = resolveMemoryByPrefix(prefix, service);
    if (matches.kind !== "one") {
      controller.addSystemMessage(matches.message);
      return true;
    }
    try {
      const memory = service.forgetMemory(matches.item.memoryId, reviewerId, "manual memory forget from TUI");
      controller.addSystemMessage(formatMemoryList([memory]));
    } catch (error) {
      controller.addSystemMessage(error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (sub === "why") {
    if (controller.activeTaskId === null) {
      controller.addSystemMessage("No active task is available for memory recall explanation.");
      return true;
    }
    const prefix = parsed.args[1];
    if (prefix === undefined) {
      controller.addSystemMessage(
        formatMemoryRecallExplanation(service.explainMemoryRecall(controller.activeTaskId))
      );
      return true;
    }
    const matches = resolveMemoryByPrefix(prefix, service);
    if (matches.kind !== "one") {
      controller.addSystemMessage(matches.message);
      return true;
    }
    controller.addSystemMessage(
      formatMemoryRecallExplanation(
        service.explainMemoryRecall(controller.activeTaskId, matches.item.memoryId)
      )
    );
    return true;
  }
  controller.addSystemMessage("Usage: /memory | /memory review | /memory add <profile|project> <text> | /memory forget <memory-id-prefix> | /memory why [memory-id-prefix]");
  return true;
}

function handleThreadCommand(text: string, controller: ReturnType<typeof useChatController>, service: AgentApplicationService): boolean {
  const parsed = parseSlashInput(text);
  const sub = parsed.args[0] ?? "summary";
  if (parsed.command !== "/thread") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }

  if (sub === "new") {
    const title = parsed.rest.slice("new".length).trim() || "Untitled thread";
    const threadId = controller.createAndActivateThread(title);
    controller.resetVisibleChatPreserveActiveThread();
    controller.addSystemMessage(`Switched to new thread ${threadId.slice(0, 8)} | ${title}`);
    controller.addSystemMessage(formatThreadDetailForTui(service, threadId));
    return true;
  }

  if (sub === "switch") {
    const prefix = parsed.args[1] ?? "";
    if (prefix.length === 0) {
      controller.addSystemMessage("Usage: /thread switch <thread-id-prefix>");
      return true;
    }
    const userId = resolveRuntimeUserId();
    const candidates = service
      .listThreads("active")
      .filter((item) => item.ownerUserId === userId && item.threadId.startsWith(prefix));
    if (candidates.length !== 1) {
      controller.addSystemMessage(
        candidates.length === 0
          ? `No thread matched prefix '${prefix}'.`
          : `Ambiguous thread prefix '${prefix}':\n${candidates.map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title}`).join("\n")}`
      );
      return true;
    }
    const match = candidates[0];
    if (match === undefined) {
      return true;
    }
    controller.switchActiveThread(match.threadId);
    controller.resetVisibleChatPreserveActiveThread();
    controller.addSystemMessage(`Switched to thread ${match.threadId.slice(0, 8)} | ${match.title}`);
    controller.addSystemMessage(formatThreadDetailForTui(service, match.threadId));
    return true;
  }

  if (sub === "list") {
    const userId = resolveRuntimeUserId();
    const threads = service
      .listThreads("active")
      .filter((item) => item.ownerUserId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
    controller.addSystemMessage(
      threads.length === 0
        ? `Active threads (user=${userId}): none`
        : `Active threads (user=${userId}, showing ${threads.length}):\n${threads
            .map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title} [${item.status}]`)
            .join("\n")}`
    );
    return true;
  }

  if (sub === "summary") {
    const maybePrefix = parsed.args[1] ?? "";
    if (maybePrefix.length > 0) {
      const userId = resolveRuntimeUserId();
      const candidates = service
        .listThreads("active")
        .filter((item) => item.ownerUserId === userId && item.threadId.startsWith(maybePrefix));
      if (candidates.length !== 1) {
        controller.addSystemMessage(
          candidates.length === 0
            ? `No thread matched prefix '${maybePrefix}'.`
            : `Ambiguous thread prefix '${maybePrefix}':\n${candidates.map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title}`).join("\n")}`
        );
        return true;
      }
      controller.addSystemMessage(formatThreadDetailForTui(service, candidates[0]!.threadId));
      return true;
    }
    if (controller.activeThreadId !== null) {
      controller.addSystemMessage(formatThreadDetailForTui(service, controller.activeThreadId));
    } else {
      return handleThreadCommand("/thread list", controller, service);
    }
    return true;
  }

  controller.addSystemMessage("Usage: /thread [new [title]|list|switch <thread-id-prefix>|summary [thread-id-prefix]]");
  return true;
}

export function handleScheduleCommand(
  text: string,
  controller: ScheduleCommandController,
  service: Pick<
    AgentApplicationService,
    "createSchedule" | "listSchedules" | "pauseSchedule" | "resumeSchedule"
  >,
  options: ScheduleCommandOptions
): boolean {
  const { args, command, rest } = parseSlashInput(text);
  if (command !== "/schedule") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const filter = args[1] ?? "active";
    if (filter !== "active" && filter !== "paused" && filter !== "all") {
      controller.addSystemMessage("Usage: /schedule list [active|paused|all]");
      return true;
    }
    const userId = resolveRuntimeUserId();
    const schedules = service
      .listSchedules({
        ownerUserId: userId,
        ...(filter === "all" ? {} : { status: filter })
      })
      .sort((left, right) => (left.nextFireAt ?? "9999-12-31T23:59:59.999Z").localeCompare(right.nextFireAt ?? "9999-12-31T23:59:59.999Z"))
      .slice(0, 20);
    controller.addSystemMessage(
      schedules.length === 0
        ? `Schedules (${filter}, user=${userId}): none`
        : `Schedules (${filter}, user=${userId}, showing ${schedules.length}):\n${schedules
            .map((item) => `- ${item.scheduleId.slice(0, 8)} | ${item.name} [${item.status}] | next=${item.nextFireAt ?? "none"}`)
            .join("\n")}`
    );
    return true;
  }
  if (sub === "create") {
    const payload = rest.slice("create".length).trim();
    const separatorIndex = payload.indexOf("|");
    if (separatorIndex <= 0 || separatorIndex === payload.length - 1) {
      controller.addSystemMessage(
        "Usage: /schedule create <when> | <prompt>\nExample: /schedule create 每天 | review inbox"
      );
      return true;
    }
    const whenText = payload.slice(0, separatorIndex).trim();
    const prompt = payload.slice(separatorIndex + 1).trim();
    if (whenText.length === 0 || prompt.length === 0) {
      controller.addSystemMessage(
        "Usage: /schedule create <when> | <prompt>\nExample: /schedule create 今天 18:30 | summarize today"
      );
      return true;
    }
    try {
      const parsed = parseNaturalLanguageScheduleWhen(whenText);
      const schedule = service.createSchedule({
        agentProfileId: "executor",
        cwd: options.cwd,
        input: prompt,
        name: deriveScheduleName(prompt),
        ownerUserId: resolveRuntimeUserId(),
        providerName: options.providerName,
        ...(controller.activeThreadId !== null ? { threadId: controller.activeThreadId } : {}),
        ...(parsed.every !== undefined ? { every: parsed.every } : {}),
        ...(parsed.runAt !== undefined ? { runAt: parsed.runAt } : {})
      });
      controller.addSystemMessage(
        `Scheduled ${schedule.scheduleId.slice(0, 8)} | ${schedule.name} [${schedule.status}] | next=${schedule.nextFireAt ?? "none"}`
      );
    } catch (error) {
      controller.addSystemMessage(
        `${error instanceof Error ? error.message : String(error)}\nExample: /schedule create 每周 | prepare weekly review`
      );
    }
    return true;
  }
  if (sub === "pause" || sub === "resume") {
    const prefix = args[1] ?? "";
    if (prefix.length === 0) {
      controller.addSystemMessage(`Usage: /schedule ${sub} <schedule-id-prefix>`);
      return true;
    }
    const matches = resolveScheduleByPrefix(prefix, service);
    if (matches.kind !== "one") {
      controller.addSystemMessage(matches.message);
      return true;
    }
    const updated =
      sub === "pause"
        ? service.pauseSchedule(matches.item.scheduleId)
        : service.resumeSchedule(matches.item.scheduleId);
    controller.addSystemMessage(
      `Schedule ${sub}d: ${updated.scheduleId.slice(0, 8)} | ${updated.name} [${updated.status}] | next=${updated.nextFireAt ?? "none"}`
    );
    return true;
  }
  controller.addSystemMessage(
    "Usage: /schedule | /schedule list [active|paused|all] | /schedule create <when> | <prompt> | /schedule pause <schedule-id-prefix> | /schedule resume <schedule-id-prefix>"
  );
  return true;
}

function resolveMemoryByPrefix(
  prefix: string,
  service: AgentApplicationService
):
  | { item: ReturnType<AgentApplicationService["listMemories"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const matches = service.listMemories().filter((item) => item.memoryId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No memory matched prefix '${prefix}'.`
        : `Ambiguous memory prefix '${prefix}':\n${matches.map((item) => `- ${item.memoryId} | ${item.title}`).join("\n")}`
  };
}

function resolveScheduleByPrefix(
  prefix: string,
  service: Pick<AgentApplicationService, "listSchedules">
):
  | { item: ReturnType<AgentApplicationService["listSchedules"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const userId = resolveRuntimeUserId();
  const matches = service
    .listSchedules({ ownerUserId: userId })
    .filter((item) => item.scheduleId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No schedule matched prefix '${prefix}'.`
        : `Ambiguous schedule prefix '${prefix}':\n${matches.map((item) => `- ${item.scheduleId.slice(0, 8)} | ${item.name}`).join("\n")}`
  };
}

function deriveScheduleName(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u)[0]?.trim() ?? "";
  const normalized = firstLine.length > 0 ? firstLine : "Scheduled routine";
  return normalized.slice(0, 80);
}

function handleNextActionCommand(text: string, controller: ReturnType<typeof useChatController>, service: AgentApplicationService): boolean {
  const { args, command } = parseSlashInput(text);
  if (command !== "/next") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const requestedThreadPrefix = args[1] ?? "";
    const threadId = resolveThreadIdForList(controller.activeThreadId, requestedThreadPrefix, service);
    if (threadId.kind === "error") {
      controller.addSystemMessage(threadId.message);
      return true;
    }
    const resolvedThreadId = threadId.threadId;
    const query =
      resolvedThreadId === null
        ? { statuses: ["active", "pending", "blocked"] as Array<"active" | "pending" | "blocked"> }
        : { threadId: resolvedThreadId };
    const items = service.listNextActions(query).slice(0, 20);
    const scope = resolvedThreadId === null ? `user=${resolveRuntimeUserId()}` : `thread=${resolvedThreadId.slice(0, 8)}`;
    controller.addSystemMessage(
      items.length === 0
        ? `Next actions (${scope}): none`
        : `Next actions (${scope}, showing ${items.length}):\n${items
            .map((item) => `- ${item.nextActionId.slice(0, 8)} | ${item.title} [${item.status}]`)
            .join("\n")}`
    );
    return true;
  }
  const prefix = args[1] ?? "";
  if (prefix.length === 0) {
    controller.addSystemMessage(sub === "block" ? "Usage: /next block <next-action-id-prefix> <reason...>" : "Usage: /next done <next-action-id-prefix>");
    return true;
  }
  const matches = resolveNextActionByPrefix(prefix, controller.activeThreadId, service);
  if (matches.kind !== "one") {
    controller.addSystemMessage(matches.message);
    return true;
  }
  if (sub === "done") {
    const updated = service.markNextActionDone(matches.item.nextActionId);
    controller.addSystemMessage(`Next action done: ${updated.nextActionId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  if (sub === "block") {
    const reason = args.slice(2).join(" ").trim();
    if (reason.length === 0) {
      controller.addSystemMessage("Usage: /next block <next-action-id-prefix> <reason...>");
      return true;
    }
    const updated = service.blockNextAction(matches.item.nextActionId, reason);
    controller.addSystemMessage(`Next action blocked: ${updated.nextActionId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  controller.addSystemMessage("Usage: /next [list [thread-id-prefix]|done <next-action-id-prefix>|block <next-action-id-prefix> <reason...>]");
  return true;
}

function handleCommitmentCommand(text: string, controller: ReturnType<typeof useChatController>, service: AgentApplicationService): boolean {
  const { args, command } = parseSlashInput(text);
  if (command !== "/commitments") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const requestedThreadPrefix = args[1] ?? "";
    const threadId = resolveThreadIdForList(controller.activeThreadId, requestedThreadPrefix, service);
    if (threadId.kind === "error") {
      controller.addSystemMessage(threadId.message);
      return true;
    }
    const resolvedThreadId = threadId.threadId;
    const query =
      resolvedThreadId === null
        ? {
            ownerUserId: resolveRuntimeUserId(),
            statuses: ["open", "in_progress", "blocked", "waiting_decision"] as Array<
              "open" | "in_progress" | "blocked" | "waiting_decision"
            >
          }
        : { threadId: resolvedThreadId };
    const items = service.listCommitments(query).slice(0, 20);
    const scope = resolvedThreadId === null ? `user=${resolveRuntimeUserId()}` : `thread=${resolvedThreadId.slice(0, 8)}`;
    controller.addSystemMessage(
      items.length === 0
        ? `Commitments (${scope}): none`
        : `Commitments (${scope}, showing ${items.length}):\n${items
            .map((item) => `- ${item.commitmentId.slice(0, 8)} | ${item.title} [${item.status}]`)
            .join("\n")}`
    );
    return true;
  }
  const prefix = args[1] ?? "";
  if (prefix.length === 0) {
    controller.addSystemMessage(
      sub === "block"
        ? "Usage: /commitments block <commitment-id-prefix> <reason...>"
        : "Usage: /commitments done <commitment-id-prefix>"
    );
    return true;
  }
  const matches = resolveCommitmentByPrefix(prefix, controller.activeThreadId, service);
  if (matches.kind !== "one") {
    controller.addSystemMessage(matches.message);
    return true;
  }
  if (sub === "done") {
    const updated = service.completeCommitment(matches.item.commitmentId);
    controller.addSystemMessage(`Commitment completed: ${updated.commitmentId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  if (sub === "block") {
    const reason = args.slice(2).join(" ").trim();
    if (reason.length === 0) {
      controller.addSystemMessage("Usage: /commitments block <commitment-id-prefix> <reason...>");
      return true;
    }
    const updated = service.blockCommitment(matches.item.commitmentId, reason);
    controller.addSystemMessage(`Commitment blocked: ${updated.commitmentId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  controller.addSystemMessage("Usage: /commitments [list [thread-id-prefix]|done <commitment-id-prefix>|block <commitment-id-prefix> <reason...>]");
  return true;
}

function resolveThreadIdForList(
  activeThreadId: string | null,
  prefix: string,
  service: AgentApplicationService
): { kind: "ok"; threadId: string | null } | { kind: "error"; message: string } {
  if (prefix.length === 0) {
    return { kind: "ok", threadId: activeThreadId };
  }
  const userId = resolveRuntimeUserId();
  const matches = service
    .listThreads("active")
    .filter((item) => item.ownerUserId === userId && item.threadId.startsWith(prefix));
  if (matches.length === 1) {
    return { kind: "ok", threadId: matches[0]!.threadId };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No thread matched prefix '${prefix}'.`
        : `Ambiguous thread prefix '${prefix}':\n${matches.map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title}`).join("\n")}`
  };
}

function resolveNextActionByPrefix(
  prefix: string,
  activeThreadId: string | null,
  service: AgentApplicationService
):
  | { item: ReturnType<AgentApplicationService["listNextActions"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const items = activeThreadId === null ? service.listNextActions() : service.listNextActions({ threadId: activeThreadId });
  const matches = items.filter((item) => item.nextActionId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  if (matches.length === 0 && activeThreadId !== null) {
    const globalMatches = service.listNextActions().filter((item) => item.nextActionId.startsWith(prefix));
    if (globalMatches.length === 1) {
      return { item: globalMatches[0]!, kind: "one" };
    }
    return {
      kind: "error",
      message:
        globalMatches.length === 0
          ? `No next action matched prefix '${prefix}'.`
          : `Ambiguous next action prefix '${prefix}':\n${globalMatches
              .map((item) => `- ${item.nextActionId.slice(0, 8)} | ${item.title}`)
              .join("\n")}`
    };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No next action matched prefix '${prefix}'.`
        : `Ambiguous next action prefix '${prefix}':\n${matches.map((item) => `- ${item.nextActionId.slice(0, 8)} | ${item.title}`).join("\n")}`
  };
}

function resolveCommitmentByPrefix(
  prefix: string,
  activeThreadId: string | null,
  service: AgentApplicationService
):
  | { item: ReturnType<AgentApplicationService["listCommitments"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const items = activeThreadId === null ? service.listCommitments() : service.listCommitments({ threadId: activeThreadId });
  const matches = items.filter((item) => item.commitmentId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  if (matches.length === 0 && activeThreadId !== null) {
    const globalMatches = service.listCommitments().filter((item) => item.commitmentId.startsWith(prefix));
    if (globalMatches.length === 1) {
      return { item: globalMatches[0]!, kind: "one" };
    }
    return {
      kind: "error",
      message:
        globalMatches.length === 0
          ? `No commitment matched prefix '${prefix}'.`
          : `Ambiguous commitment prefix '${prefix}':\n${globalMatches
              .map((item) => `- ${item.commitmentId.slice(0, 8)} | ${item.title}`)
              .join("\n")}`
    };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No commitment matched prefix '${prefix}'.`
        : `Ambiguous commitment prefix '${prefix}':\n${matches.map((item) => `- ${item.commitmentId.slice(0, 8)} | ${item.title}`).join("\n")}`
  };
}

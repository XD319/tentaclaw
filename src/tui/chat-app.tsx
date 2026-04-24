import { randomUUID } from "node:crypto";
import React from "react";
import { Box, Text, useApp } from "ink";

import type { AgentApplicationService, AppConfig } from "../runtime/index.js";
import { Banner } from "./components/banner.js";
import { InputBox } from "./components/input-box.js";
import { MessageStream, StaticMessageStream } from "./components/message-stream.js";
import { buildTokenMetrics, StatusBar } from "./components/status-bar.js";
import { useChatController } from "./hooks/use-chat-controller.js";
import { useTextInput } from "./hooks/use-text-input.js";
import { listSessionIds, saveSession } from "./session-store.js";
import { completeSlashCommand } from "./slash-commands.js";
import { theme } from "./theme.js";
import { displayChatMessages, type ChatMessage } from "./view-models/chat-messages.js";

export interface ChatTuiAppProps {
  config: AppConfig;
  cwd: string;
  initialMessages?: ChatMessage[];
  initialSessionId: string;
  reviewerId: string;
  service: AgentApplicationService;
}

export function ChatTuiApp({
  config,
  cwd,
  initialMessages,
  initialSessionId,
  reviewerId,
  service
}: ChatTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const [sessionTitle, setSessionTitle] = React.useState("chat");
  const [sessionId, setSessionId] = React.useState(initialSessionId);
  const historyRef = React.useRef<string[]>([]);
  const historyIndexRef = React.useRef<number | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const controller = useChatController({
    config,
    cwd,
    ...(initialMessages !== undefined ? { initialMessages } : {}),
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
        updatedAt: new Date().toISOString()
      });
    }, 600);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [config.workspaceRoot, controller.busy, controller.messages, sessionId]);

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

  const handleSlashCommand = React.useCallback(
    (text: string): boolean => {
      if (!text.startsWith("/")) {
        return false;
      }

      if (text === "/help") {
        controller.addSystemMessage(
          [
            "Commands: /help /clear /new /stop /title <name> /history /status /sandbox /rollback <id|last> /cost /context /diff /sessions",
            "Tip: use `talon tui --mode dashboard` or `talon dashboard` for the observability view.",
            "Shortcuts: Enter send | Alt+Enter / Ctrl+J newline | Ctrl+Shift+V paste | Tab slash-complete | Ctrl+P/N history",
            "Session files: .auto-talon/sessions/<id>.json | resume: talon tui --resume <id>",
            "Token pricing estimate: AGENT_TOKEN_PRICE_IN_PER_M / AGENT_TOKEN_PRICE_OUT_PER_M (optional)",
            "Transcript scroll uses the terminal buffer; use your terminal scrollbar or mouse wheel."
          ].join("\n")
        );
        return true;
      }

      if (text === "/clear") {
        controller.clearConversation();
        return true;
      }

      if (text === "/new") {
        controller.clearConversation();
        setSessionTitle("chat");
        const nextId = randomUUID();
        setSessionId(nextId);
        controller.addSystemMessage(`Started a new chat session. id=${nextId}`);
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
        controller.addSystemMessage("Open dashboard with: talon tui --mode dashboard (or talon dashboard).");
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
          `busy: ${controller.busy}`,
          `active_task: ${controller.activeTaskId ?? "(none)"}`,
          `tasks: ${controller.summary.tasks} running: ${controller.summary.runningTasks} approvals: ${controller.summary.pendingApprovals}`,
          `status_line: ${controller.statusLine}`,
          `ui_status: ${controller.uiStatus.primaryLabel}`,
          `elapsed: ${controller.runDurationLabel}`,
          "ui_scroll: terminal",
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

  const textInput = useTextInput({
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
    onTabComplete: completeSlashCommand,
    onSubmit: (value) => {
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

  const slashHints =
    textInput.value.startsWith("/") && textInput.value.length > 0
      ? [
          "/clear",
          "/context",
          "/cost",
          "/diff",
          "/dashboard",
          "/help",
          "/history",
          "/new",
          "/rollback ",
          "/sessions",
          "/sandbox",
          "/status",
          "/stop",
          "/title "
        ].filter((command) => command.startsWith(textInput.value))
      : [];

  return (
    <Box flexDirection="column">
      <StaticMessageStream messages={staticMessages} />
      <Banner
        details={[config.provider.model ?? config.provider.name, shortenPath(cwd, 20)]}
        productName="AUTOTALON"
        title={sessionTitle === "chat" ? "Interactive Chat" : sessionTitle}
      />
      <Box flexDirection="column">
        {liveMessages.length > 0 ? (
          <MessageStream messages={liveMessages} />
        ) : staticMessages.length === 0 ? (
          <Text color={theme.muted}>No messages yet.</Text>
        ) : null}
      </Box>
      <Box>
        <InputBox
          busy={controller.busy}
          hasPendingApproval={controller.hasPendingApproval}
          lines={textInput.lines}
          slashHints={slashHints}
          value={textInput.value}
        />
      </Box>
      <Box>
        <StatusBar
          details={[`elapsed ${controller.runDurationLabel}`]}
          hints={[controller.hasPendingApproval ? "a allow | d deny" : "Enter send"]}
          metrics={buildTokenMetrics(
            controller.tokenHud.inputTokens,
            controller.tokenHud.outputTokens,
            controller.tokenHud.contextPercent,
            controller.tokenHud.estimatedCostUsd
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

function isLiveTranscriptMessage(message: ChatMessage): boolean {
  return (
    (message.kind === "agent" && message.streaming === true) ||
    (message.kind === "approval" && message.status === "pending")
  );
}

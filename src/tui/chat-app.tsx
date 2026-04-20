import { randomUUID } from "node:crypto";
import React from "react";
import { Box, Text, useApp } from "ink";

import type { AgentApplicationService, AppConfig } from "../runtime";
import type { ChatMessage } from "./view-models/chat-messages";
import { Banner } from "./components/banner";
import { InputBox } from "./components/input-box";
import { MessageStream } from "./components/message-stream";
import { Spinner } from "./components/spinner";
import { StatusBar } from "./components/status-bar";
import { useChatController } from "./hooks/use-chat-controller";
import { useMouseScrollUnsupportedNotice } from "./hooks/use-mouse-scroll";
import { useScrollback } from "./hooks/use-scrollback";
import { useTextInput } from "./hooks/use-text-input";
import { listSessionIds, saveSession } from "./session-store";
import { completeSlashCommand } from "./slash-commands";

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
  useMouseScrollUnsupportedNotice();
  const { exit } = useApp();
  const [collapseActivities, setCollapseActivities] = React.useState(true);
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

  const scrollback = useScrollback(controller.messages.length, 10);
  const visibleMessages = controller.messages.slice(scrollback.startIndex, scrollback.endIndexExclusive);

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
  }, [config.workspaceRoot, controller.messages, controller.busy, sessionId]);

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
            "Shortcuts: Enter send · Alt+Enter / Ctrl+J newline · Ctrl+Shift+V paste · Tab slash-complete · Ctrl+P/N history · Ctrl+T activity · PageUp/Down scroll · Ctrl+G top",
            "Session files: .auto-talon/sessions/<id>.json · resume: agent tui --resume <id>",
            "Token pricing estimate: AGENT_TOKEN_PRICE_IN_PER_M / AGENT_TOKEN_PRICE_OUT_PER_M (optional)",
            "Mouse wheel is not wired with Ink 3; use PageUp/PageDown for transcript scroll."
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
        if (requested) {
          controller.addSystemMessage("Stop requested for current task.");
        } else {
          controller.addSystemMessage("No running task to stop.");
        }
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
          `Session token estimate (provider telemetry): in=${u.inputTokens} out=${u.outputTokens} · ~$${u.estimatedCostUsd.toFixed(4)}`
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
          `elapsed: ${controller.runDurationLabel}`,
          `ui_scroll: ${scrollback.atBottom ? "follow" : "paused"}`,
          `activity_feed: ${collapseActivities ? "collapsed" : "expanded"}`,
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
      collapseActivities,
      config.provider.model,
      config.provider.name,
      config.sandbox,
      config.tokenBudget,
      config.workspaceRoot,
      controller,
      cwd,
      reviewerId,
      service,
      scrollback.atBottom,
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
      if (requested) {
        controller.addSystemMessage(
          "Interrupt requested. Press Ctrl+C again within 2s to force exit if shutdown is needed."
        );
      } else {
        controller.addSystemMessage("No running task to interrupt.");
      }
    },
    onApprovalAction: (action) => {
      void controller.resolvePendingApproval(action);
    },
    onExit: exit,
    onScrollPageDown: scrollback.scrollPageDown,
    onScrollPageUp: scrollback.scrollPageUp,
    onScrollEnd: scrollback.scrollToEnd,
    onScrollStart: scrollback.scrollToStart,
    onTabComplete: completeSlashCommand,
    onToggleActivityCollapse: () => {
      setCollapseActivities((current) => !current);
    },
    onSubmit: (value) => {
      if (handleSlashCommand(value)) {
        return;
      }
      historyRef.current.push(value);
      if (historyRef.current.length > 200) {
        historyRef.current = historyRef.current.slice(-200);
      }
      historyIndexRef.current = null;
      void controller.submitPrompt(value);
      scrollback.scrollToBottom();
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

  React.useEffect(() => {
    if (!scrollback.atBottom) {
      return;
    }
    const latest = controller.messages.at(-1);
    if (latest === undefined) {
      return;
    }
    if (latest.kind === "agent" || latest.kind === "error" || latest.kind === "system") {
      scrollback.scrollToBottom();
    }
  }, [controller.messages, scrollback.scrollToBottom]);

  return (
    <Box flexDirection="column">
      <Banner
        cwd={cwd}
        modelLabel={config.provider.model ?? config.provider.name}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
      />
      <Box flexDirection="column" marginTop={1}>
        <MessageStream collapseActivities={collapseActivities} messages={visibleMessages} />
      </Box>
      <Box marginTop={1}>
        <Spinner active={controller.busy} />
      </Box>
      <StatusBar
        atBottom={scrollback.atBottom}
        contextPercent={controller.tokenHud.contextPercent}
        estimatedCostUsd={controller.tokenHud.estimatedCostUsd}
        inputTokens={controller.tokenHud.inputTokens}
        outputTokens={controller.tokenHud.outputTokens}
        statusLine={controller.statusLine}
      />
      {slashHints.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" dimColor>
            Slash hints ({slashHints.length})
          </Text>
          {slashHints.slice(0, 8).map((line) => (
            <Text key={line} color="gray">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <InputBox busy={controller.busy} lines={textInput.lines} value={textInput.value} />
      </Box>
    </Box>
  );
}

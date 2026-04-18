import React from "react";
import { Box, useApp } from "ink";

import type { AgentApplicationService, AppConfig } from "../runtime";
import { Banner } from "./components/banner";
import { InputBox } from "./components/input-box";
import { MessageStream } from "./components/message-stream";
import { Spinner } from "./components/spinner";
import { StatusBar } from "./components/status-bar";
import { useChatController } from "./hooks/use-chat-controller";
import { useScrollback } from "./hooks/use-scrollback";
import { useTextInput } from "./hooks/use-text-input";

export interface ChatTuiAppProps {
  config: AppConfig;
  cwd: string;
  reviewerId: string;
  service: AgentApplicationService;
}

export function ChatTuiApp({ config, cwd, reviewerId, service }: ChatTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const [collapseActivities, setCollapseActivities] = React.useState(false);
  const historyRef = React.useRef<string[]>([]);
  const historyIndexRef = React.useRef<number | null>(null);
  const controller = useChatController({
    config,
    cwd,
    reviewerId,
    service
  });
  const scrollback = useScrollback(controller.messages.length, 10);
  const visibleMessages = controller.messages.slice(scrollback.startIndex, scrollback.endIndexExclusive);
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
          "Commands: /help, /clear, /new. Shortcuts: Ctrl+P/N history, Ctrl+T toggle activity, Ctrl+G/J top/bottom."
        );
        return true;
      }

      if (text === "/clear") {
        controller.clearConversation();
        return true;
      }

      if (text === "/new") {
        controller.clearConversation();
        controller.addSystemMessage("Started a new chat session.");
        return true;
      }

      controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
      return true;
    },
    [controller]
  );

  const textInput = useTextInput({
    busy: controller.busy,
    hasPendingApproval: controller.hasPendingApproval,
    onHistoryNext: navigateHistoryNext,
    onHistoryPrevious: navigateHistoryPrevious,
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
    onToggleActivityCollapse: () => {
      setCollapseActivities((current) => !current);
    },
    onSubmit: (text) => {
      historyRef.current.push(text);
      if (historyRef.current.length > 200) {
        historyRef.current = historyRef.current.slice(-200);
      }
      historyIndexRef.current = null;

      if (handleSlashCommand(text)) {
        return;
      }
      void controller.submitPrompt(text);
      scrollback.scrollToBottom();
    }
  });

  return (
    <Box flexDirection="column">
      <Banner cwd={cwd} modelLabel={config.provider.model ?? config.provider.name} />
      <Box marginTop={1} flexDirection="column">
        <MessageStream collapseActivities={collapseActivities} messages={visibleMessages} />
      </Box>
      <Box marginTop={1}>
        <Spinner active={controller.busy} />
      </Box>
      <StatusBar
        atBottom={scrollback.atBottom}
        pendingApprovals={controller.summary.pendingApprovals}
        runDurationLabel={controller.runDurationLabel}
        runningTasks={controller.summary.runningTasks}
        statusLine={controller.statusLine}
        taskCount={controller.summary.tasks}
      />
      <Box marginTop={1}>
        <InputBox
          busy={controller.busy}
          cursorIndex={textInput.cursorIndex}
          lines={textInput.lines}
          value={textInput.value}
        />
      </Box>
    </Box>
  );
}

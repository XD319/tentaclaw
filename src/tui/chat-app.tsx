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
  const controller = useChatController({
    config,
    cwd,
    reviewerId,
    service
  });
  const scrollback = useScrollback(controller.messages.length, 10);
  const visibleMessages = controller.messages.slice(scrollback.startIndex, scrollback.endIndexExclusive);
  const textInput = useTextInput({
    busy: controller.busy,
    hasPendingApproval: controller.hasPendingApproval,
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

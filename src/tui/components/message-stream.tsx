import React from "react";
import { Box, Text } from "ink";

import type { ChatMessage } from "../view-models/chat-messages";
import { AgentMessage } from "./agent-message";
import { ApprovalCard } from "./approval-card";
import { ErrorMessage } from "./error-message";
import { ToolActivity } from "./tool-activity";
import { UserMessage } from "./user-message";

export interface MessageStreamProps {
  collapseActivities: boolean;
  messages: ChatMessage[];
}

export function MessageStream({ collapseActivities, messages }: MessageStreamProps): React.ReactElement {
  const activityCount = messages.filter((message) => message.kind === "activity").length;
  const visibleMessages = collapseActivities
    ? messages.filter((message) => message.kind !== "activity")
    : messages;

  return (
    <Box flexDirection="column">
      {collapseActivities && activityCount > 0 ? (
        <Text color="gray">| {activityCount} activity lines hidden (Ctrl+T to expand)</Text>
      ) : null}
      {visibleMessages.map((message) => {
        if (message.kind === "user") {
          return <UserMessage key={message.id} text={message.text} />;
        }
        if (message.kind === "agent") {
          return <AgentMessage key={message.id} text={message.text} />;
        }
        if (message.kind === "activity") {
          return <ToolActivity key={message.id} text={message.text} />;
        }
        if (message.kind === "approval") {
          return (
            <Box key={message.id} marginY={1}>
              <ApprovalCard approval={message.approval} toolCall={message.toolCall} />
            </Box>
          );
        }
        if (message.kind === "error") {
          return (
            <ErrorMessage
              key={message.id}
              code={message.code}
              message={message.message}
              source={message.source}
            />
          );
        }
        return <Text key={message.id} color="gray">{message.text}</Text>;
      })}
    </Box>
  );
}

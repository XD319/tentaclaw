import React from "react";
import { Box, Static, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize.js";
import type { ChatMessage } from "../view-models/chat-messages.js";
import { AgentMessage } from "./agent-message.js";
import { ApprovalCard } from "./approval-card.js";
import { ErrorMessage } from "./error-message.js";
import { UserMessage } from "./user-message.js";

export interface MessageStreamProps {
  messages: ChatMessage[];
}

export function MessageStream({ messages }: MessageStreamProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </Box>
  );
}

export function StaticMessageStream({ messages }: MessageStreamProps): React.ReactElement {
  return (
    <Static items={messages}>
      {(message) => <MessageItem key={message.id} message={message} />}
    </Static>
  );
}

function MessageItem({ message }: { message: ChatMessage }): React.ReactElement {
  if (message.kind === "user") {
    return <UserMessage text={message.text} />;
  }
  if (message.kind === "agent") {
    return (
      <AgentMessage
        {...(message.streaming === true ? { streaming: true } : {})}
        text={message.text}
      />
    );
  }
  if (message.kind === "approval") {
    if (message.status === "resolved") {
      const action = message.resolution ?? "allow";
      const label = action === "allow" ? "Approved" : "Denied";
      return (
        <Text color={action === "allow" ? "green" : "red"}>
          [approval] {label} {message.approval.toolName} for task {message.approval.taskId.slice(0, 8)}.
        </Text>
      );
    }

    return (
      <Box marginY={1}>
        <ApprovalCard
          approval={message.approval}
          toolCall={message.toolCall}
        />
      </Box>
    );
  }
  if (message.kind === "approval_result") {
    return (
      <Text color={message.action === "allow" ? "green" : "red"}>
        [approval] {message.text}
      </Text>
    );
  }
  if (message.kind === "error") {
    return (
      <ErrorMessage
        code={message.code}
        message={message.message}
        source={message.source}
      />
    );
  }
  return <Text color="gray">{sanitizeTerminalText(message.text)}</Text>;
}

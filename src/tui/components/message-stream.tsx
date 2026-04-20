import React from "react";
import { Box, Static, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize";
import type { ChatMessage } from "../view-models/chat-messages";
import { AgentMessage } from "./agent-message";
import { ApprovalCard } from "./approval-card";
import { ErrorMessage } from "./error-message";
import { UserMessage } from "./user-message";

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
    return (
      <Box marginY={1}>
        <ApprovalCard approval={message.approval} toolCall={message.toolCall} />
      </Box>
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

import React from "react";
import { Box, Static, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize.js";
import { theme } from "../theme.js";
import type { ChatMessage } from "../view-models/chat-messages.js";
import type { TraceEvent } from "../../types/index.js";
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
      {messages.map((message, index) => (
        <React.Fragment key={message.id}>
          {needsTurnSeparator(messages[index - 1], message) ? <Text color={theme.muted}> </Text> : null}
          <MessageItem message={message} />
        </React.Fragment>
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
        <Text color={action === "allow" ? theme.success : theme.danger}>
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
      <Text color={message.action === "allow" ? theme.success : theme.danger}>
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
  if (message.kind === "activity") {
    return (
      <Text color={activityColor(message.event.eventType)} wrap="wrap">
        {activityPrefix(message.event.eventType)} {sanitizeTerminalText(message.text)}
      </Text>
    );
  }
  return <Text color={theme.muted}>{sanitizeTerminalText(message.text)}</Text>;
}

function needsTurnSeparator(previous: ChatMessage | undefined, current: ChatMessage): boolean {
  if (previous === undefined) {
    return false;
  }
  const turnKinds = new Set(["user", "agent"]);
  return turnKinds.has(previous.kind) && turnKinds.has(current.kind) && previous.kind !== current.kind;
}

function activityPrefix(eventType: TraceEvent["eventType"]): string {
  if (eventType === "tool_call_requested" || eventType === "tool_call_started" || eventType === "tool_call_finished") {
    return ">";
  }
  if (eventType === "tool_call_failed" || eventType === "provider_request_failed") {
    return "x";
  }
  if (eventType === "approval_requested" || eventType === "approval_resolved") {
    return "!";
  }
  return "-";
}

function activityColor(eventType: TraceEvent["eventType"]): string {
  if (eventType === "tool_call_failed" || eventType === "provider_request_failed") {
    return theme.danger;
  }
  if (eventType === "approval_requested" || eventType === "retry" || eventType === "sandbox_enforced") {
    return theme.warn;
  }
  return theme.muted;
}

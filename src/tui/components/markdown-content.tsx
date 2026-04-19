import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Box, Text } from "ink";

import { theme } from "../theme";
import { HighlightCode } from "./highlight-code";

function reactChildrenToText(node: React.ReactNode): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(reactChildrenToText).join("");
  }
  return "";
}

export function MarkdownContent({ source }: { source: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }) => (
            <Text color={theme.link} underline>
              {children}
            </Text>
          ),
          blockquote: ({ children }) => (
            <Box paddingLeft={1}>
              <Text color={theme.quote}>│ {children}</Text>
            </Box>
          ),
          code: ({ className, children, inline }) => {
            const code = reactChildrenToText(children).replace(/\n$/u, "");
            if (inline === true) {
              return (
                <Text backgroundColor="black" color={theme.inlineCode}>
                  {code}
                </Text>
              );
            }
            const match = /language-([\w-]+)/u.exec(className ?? "");
            const lang = match?.[1];
            return <HighlightCode code={code} language={lang} />;
          },
          h1: ({ children }) => (
            <Box marginTop={1}>
              <Text bold color={theme.heading}>
                # {children}
              </Text>
            </Box>
          ),
          h2: ({ children }) => (
            <Box marginTop={1}>
              <Text bold color={theme.heading}>
                ## {children}
              </Text>
            </Box>
          ),
          h3: ({ children }) => (
            <Text bold color={theme.heading}>
              ### {children}
            </Text>
          ),
          hr: () => (
            <Text color="gray" dimColor>
              ────────────────────────────────────────
            </Text>
          ),
          li: ({ children }) => (
            <Text>
              • {children}
            </Text>
          ),
          ol: ({ children }) => <Box flexDirection="column">{children}</Box>,
          p: ({ children }) => (
            <Text wrap="wrap" color={theme.emphasis}>
              {children}
            </Text>
          ),
          pre: ({ children }) => <Box flexDirection="column">{children}</Box>,
          strong: ({ children }) => (
            <Text bold color={theme.emphasis}>
              {children}
            </Text>
          ),
          table: ({ children }) => (
            <Box borderStyle="single" borderColor={theme.border} flexDirection="column" marginY={1} paddingX={1}>
              {children}
            </Box>
          ),
          tbody: ({ children }) => <Box flexDirection="column">{children}</Box>,
          td: ({ children }) => (
            <Text wrap="wrap" color={theme.emphasis}>
              {children}
            </Text>
          ),
          th: ({ children }) => (
            <Text bold color={theme.heading}>
              {children}
            </Text>
          ),
          thead: ({ children }) => (
            <Box flexDirection="column" marginBottom={1}>
              {children}
            </Box>
          ),
          tr: ({ children }) => (
            <Box flexDirection="row" justifyContent="space-between">
              {children}
            </Box>
          ),
          ul: ({ children }) => <Box flexDirection="column">{children}</Box>
        }}
      >
        {source}
      </ReactMarkdown>
    </Box>
  );
}

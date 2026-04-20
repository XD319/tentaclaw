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

function sanitizeBoxChildren(children: React.ReactNode): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child, index) => {
    if (typeof child === "string") {
      if (child.trim().length === 0) {
        return [];
      }
      return [<Text key={`text:${index}`}>{child}</Text>];
    }

    if (typeof child === "number") {
      return [<Text key={`num:${index}`}>{String(child)}</Text>];
    }

    return [child];
  });
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
            <Box flexDirection="row" paddingLeft={1}>
              <Text color={theme.quote}>│ </Text>
              <Box flexDirection="column">{sanitizeBoxChildren(children)}</Box>
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
            <Box flexDirection="row">
              <Text>• </Text>
              <Box flexDirection="column">{sanitizeBoxChildren(children)}</Box>
            </Box>
          ),
          ol: ({ children }) => <Box flexDirection="column">{sanitizeBoxChildren(children)}</Box>,
          p: ({ children }) => (
            <Text wrap="wrap" color={theme.emphasis}>
              {children}
            </Text>
          ),
          pre: ({ children }) => <Box flexDirection="column">{sanitizeBoxChildren(children)}</Box>,
          strong: ({ children }) => (
            <Text bold color={theme.emphasis}>
              {children}
            </Text>
          ),
          table: ({ children }) => (
            <Box borderStyle="single" borderColor={theme.border} flexDirection="column" marginY={1} paddingX={1}>
              {sanitizeBoxChildren(children)}
            </Box>
          ),
          tbody: ({ children }) => <Box flexDirection="column">{sanitizeBoxChildren(children)}</Box>,
          td: ({ children }) => (
            <Box marginRight={2}>
              <Text wrap="wrap" color={theme.emphasis}>
                {children}
              </Text>
            </Box>
          ),
          th: ({ children }) => (
            <Box marginRight={2}>
              <Text bold color={theme.heading}>
                {children}
              </Text>
            </Box>
          ),
          thead: ({ children }) => (
            <Box flexDirection="column" marginBottom={1}>
              {sanitizeBoxChildren(children)}
            </Box>
          ),
          tr: ({ children }) => <Box flexDirection="row">{sanitizeBoxChildren(children)}</Box>,
          ul: ({ children }) => <Box flexDirection="column">{sanitizeBoxChildren(children)}</Box>
        }}
      >
        {source}
      </ReactMarkdown>
    </Box>
  );
}

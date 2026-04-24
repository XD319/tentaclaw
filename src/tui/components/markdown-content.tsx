import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import { HighlightCode } from "./highlight-code.js";

type MarkdownBlock =
  | {
      kind: "code";
      language: string | undefined;
      lines: string[];
    }
  | {
      kind: "line";
      text: string;
    };

function MarkdownContentBase({ source }: { source: string }): React.ReactElement {
  const blocks = React.useMemo(() => parseMarkdownBlocks(source), [source]);

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <HighlightCode
            key={`code:${index}`}
            code={block.lines.join("\n")}
            language={block.language}
          />
        ) : (
          renderMarkdownLine(block.text, index)
        )
      )}
    </Box>
  );
}

export const MarkdownContent = React.memo(MarkdownContentBase);

function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.split(/\r?\n/u);
  let codeLines: string[] | null = null;
  let codeLanguage: string | undefined;

  for (const line of lines) {
    const fence = /^```\s*([\w-]+)?\s*$/u.exec(line.trim());
    if (fence !== null) {
      if (codeLines === null) {
        codeLines = [];
        codeLanguage = fence[1];
      } else {
        blocks.push({
          kind: "code",
          language: codeLanguage,
          lines: codeLines
        });
        codeLines = null;
        codeLanguage = undefined;
      }
      continue;
    }

    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    blocks.push({
      kind: "line",
      text: line
    });
  }

  if (codeLines !== null) {
    blocks.push({
      kind: "code",
      language: codeLanguage,
      lines: codeLines
    });
  }

  return blocks;
}

function renderMarkdownLine(line: string, index: number): React.ReactElement {
  if (line.trim().length === 0) {
    return <Text key={`blank:${index}`}> </Text>;
  }

  const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
  if (heading !== null) {
    return (
      <Text key={`heading:${index}`} bold color={theme.heading} wrap="wrap">
        {heading[1]} {renderInlineMarkdown(heading[2] ?? "")}
      </Text>
    );
  }

  const quote = /^>\s?(.*)$/u.exec(line);
  if (quote !== null) {
    return (
      <Text key={`quote:${index}`} color={theme.quote} wrap="wrap">
        | {renderInlineMarkdown(quote[1] ?? "")}
      </Text>
    );
  }

  const unordered = /^(\s*)[-*]\s+(.+)$/u.exec(line);
  if (unordered !== null) {
    return (
      <Text key={`ul:${index}`} color={theme.emphasis} wrap="wrap">
        {indent(unordered[1] ?? "")}- {renderInlineMarkdown(unordered[2] ?? "")}
      </Text>
    );
  }

  const ordered = /^(\s*)(\d+[.)])\s+(.+)$/u.exec(line);
  if (ordered !== null) {
    return (
      <Text key={`ol:${index}`} color={theme.emphasis} wrap="wrap">
        {indent(ordered[1] ?? "")}
        {ordered[2]} {renderInlineMarkdown(ordered[3] ?? "")}
      </Text>
    );
  }

  return (
    <Text key={`p:${index}`} color={theme.emphasis} wrap="wrap">
      {renderInlineMarkdown(line)}
    </Text>
  );
}

function indent(value: string): string {
  return " ".repeat(Math.floor(value.length / 2) * 2);
}

function renderInlineMarkdown(value: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const tokenPattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      parts.push(value.slice(cursor, start));
    }
    const token = match[0];
    if (/^\*\*[^*]+\*\*$/u.test(token) || /^__[^_]+__$/u.test(token)) {
      const content = token.slice(2, -2);
      parts.push(
        <Text key={`b:${tokenIndex++}`} bold>
          {content}
        </Text>
      );
    } else if (/^`[^`]+`$/u.test(token)) {
      const content = token.slice(1, -1);
      parts.push(
        <Text key={`c:${tokenIndex++}`} color={theme.inlineCode}>
          {content}
        </Text>
      );
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      parts.push(
        <Text key={`l:${tokenIndex++}`} color={theme.link}>
          {linkMatch?.[1] ?? token}
        </Text>
      );
    }
    cursor = start + token.length;
  }
  if (cursor < value.length) {
    parts.push(value.slice(cursor));
  }
  return parts;
}

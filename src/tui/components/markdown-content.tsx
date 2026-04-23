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
        {heading[1]} {plainInlineMarkdown(heading[2] ?? "")}
      </Text>
    );
  }

  const quote = /^>\s?(.*)$/u.exec(line);
  if (quote !== null) {
    return (
      <Text key={`quote:${index}`} color={theme.quote} wrap="wrap">
        | {plainInlineMarkdown(quote[1] ?? "")}
      </Text>
    );
  }

  const unordered = /^(\s*)[-*]\s+(.+)$/u.exec(line);
  if (unordered !== null) {
    return (
      <Text key={`ul:${index}`} color={theme.emphasis} wrap="wrap">
        {indent(unordered[1] ?? "")}- {plainInlineMarkdown(unordered[2] ?? "")}
      </Text>
    );
  }

  const ordered = /^(\s*)(\d+[.)])\s+(.+)$/u.exec(line);
  if (ordered !== null) {
    return (
      <Text key={`ol:${index}`} color={theme.emphasis} wrap="wrap">
        {indent(ordered[1] ?? "")}
        {ordered[2]} {plainInlineMarkdown(ordered[3] ?? "")}
      </Text>
    );
  }

  return (
    <Text key={`p:${index}`} color={theme.emphasis} wrap="wrap">
      {plainInlineMarkdown(line)}
    </Text>
  );
}

function indent(value: string): string {
  return " ".repeat(Math.floor(value.length / 2) * 2);
}

function plainInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1");
}

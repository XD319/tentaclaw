import hljs from "highlight.js";
import type { Node as DomNode } from "node-html-parser";
import { HTMLElement, parse, TextNode } from "node-html-parser";
import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";

const HLJS_CLASS: Record<string, string> = {
  "hljs-attr": "cyan",
  "hljs-attribute": "yellow",
  "hljs-built_in": "cyan",
  "hljs-bullet": "magenta",
  "hljs-comment": "gray",
  "hljs-keyword": "magenta",
  "hljs-link": "blue",
  "hljs-literal": "yellow",
  "hljs-meta": "gray",
  "hljs-name": "cyan",
  "hljs-number": "yellow",
  "hljs-regexp": "green",
  "hljs-string": "green",
  "hljs-title": "cyan",
  "hljs-type": "yellow",
  "hljs-variable": "white"
};

type HighlightChunk = {
  color: HighlightColor | null;
  text: string;
};

type HighlightColor = "blue" | "cyan" | "gray" | "green" | "magenta" | "yellow";

function renderHtmlNode(node: DomNode, inheritedColor: HighlightColor | null = null): HighlightChunk[] {
  if (node instanceof TextNode) {
    return [{ color: inheritedColor, text: decodeHtmlEntities(node.text) }];
  }
  if (!(node instanceof HTMLElement)) {
    return [];
  }

  let nodeColor = inheritedColor;
  if (node.tagName === "SPAN") {
    const rawClass = node.getAttribute("class") ?? "";
    const cls = rawClass.split(/\s+/u).find((c) => c.startsWith("hljs-"));
    const colorKey = cls !== undefined ? HLJS_CLASS[cls] : undefined;
    nodeColor = isHighlightColor(colorKey) ? colorKey : inheritedColor;
  }

  return node.childNodes.flatMap((child) => renderHtmlNode(child, nodeColor));
}

function HighlightCodeBase({
  code,
  language
}: {
  code: string;
  language: string | undefined;
}): React.ReactElement {
  const bodyLines = React.useMemo(() => {
    let chunks: HighlightChunk[];
    try {
      const lang =
        language !== undefined && hljs.getLanguage(language) !== undefined ? language : "plaintext";
      const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      chunks = parseHighlightChunks(html);
    } catch {
      chunks = parseHighlightChunks(hljs.highlightAuto(code).value);
    }
    return splitHighlightLines(chunks.length > 0 ? chunks : [{ color: null, text: code }]);
  }, [code, language]);

  return (
    <Box borderColor={theme.border} borderStyle="classic" flexDirection="column" paddingX={1}>
      {language !== undefined && language.length > 0 ? (
        <Text color="gray" dimColor>
          {language}
        </Text>
      ) : null}
      {bodyLines.map((line, index) => (
        <Text key={`code:${index}`} wrap="truncate-end">
          {line.length > 0
            ? line.map((chunk, chunkIndex) =>
                chunk.color === null ? (
                  <Text key={`chunk:${chunkIndex}`}>{chunk.text}</Text>
                ) : (
                  <Text key={`chunk:${chunkIndex}`} color={chunk.color}>
                    {chunk.text}
                  </Text>
                )
              )
            : " "}
        </Text>
      ))}
    </Box>
  );
}

export const HighlightCode = React.memo(HighlightCodeBase);

function parseHighlightChunks(html: string): HighlightChunk[] {
  const wrapped = parse(`<div>${html}</div>`);
  const root = wrapped.querySelector("div");
  return root?.childNodes.flatMap((child) => renderHtmlNode(child)) ?? [];
}

function splitHighlightLines(chunks: HighlightChunk[]): HighlightChunk[][] {
  const lines: HighlightChunk[][] = [[]];
  for (const chunk of chunks) {
    const parts = chunk.text.split(/\r?\n/u);
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part.length > 0) {
        lines[lines.length - 1]?.push({ color: chunk.color, text: part });
      }
    });
  }
  return lines;
}

function isHighlightColor(value: string | undefined): value is HighlightColor {
  return (
    value === "blue" ||
    value === "cyan" ||
    value === "gray" ||
    value === "green" ||
    value === "magenta" ||
    value === "yellow"
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

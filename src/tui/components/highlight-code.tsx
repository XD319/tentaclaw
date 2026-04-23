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

function renderHtmlNode(node: DomNode, key: number): React.ReactNode {
  if (node instanceof TextNode) {
    return node.rawText;
  }
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  if (node.tagName === "SPAN") {
    const rawClass = node.getAttribute("class") ?? "";
    const cls = rawClass.split(/\s+/u).find((c) => c.startsWith("hljs-"));
    const colorKey = cls !== undefined ? HLJS_CLASS[cls] : undefined;
    const inkColor =
      colorKey === undefined || colorKey === "white"
        ? null
        : (colorKey as "cyan" | "yellow" | "magenta" | "green" | "blue" | "gray");
    const children = node.childNodes.map((child, index) => renderHtmlNode(child, index));
    return inkColor === null ? (
      <Text key={key}>{children}</Text>
    ) : (
      <Text key={key} color={inkColor}>
        {children}
      </Text>
    );
  }
  return node.childNodes.map((child, index) => renderHtmlNode(child, index));
}

function HighlightCodeBase({
  code,
  language
}: {
  code: string;
  language: string | undefined;
}): React.ReactElement {
  const body = React.useMemo(() => {
    let html: string;
    try {
      const lang =
        language !== undefined && hljs.getLanguage(language) !== undefined ? language : "plaintext";
      html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      html = hljs.highlightAuto(code).value;
    }
    const wrapped = parse(`<div>${html}</div>`);
    const root = wrapped.querySelector("div");
    return root?.childNodes.map((child, index) => renderHtmlNode(child, index)) ?? [
      <Text key="f">{code}</Text>
    ];
  }, [code, language]);

  return (
    <Box borderColor={theme.border} borderStyle="round" flexDirection="column" paddingX={1}>
      {language !== undefined && language.length > 0 ? (
        <Text color="gray" dimColor>
          {language}
        </Text>
      ) : null}
      <Text wrap="wrap">{body}</Text>
    </Box>
  );
}

export const HighlightCode = React.memo(HighlightCodeBase);

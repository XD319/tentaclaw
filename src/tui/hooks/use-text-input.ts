import React from "react";
import { useInput } from "ink";

export interface UseTextInputOptions {
  onHistoryNext: () => string | null;
  onHistoryPrevious: () => string | null;
  onInterruptRequest: () => void;
  onToggleActivityCollapse: () => void;
  onScrollEnd: () => void;
  onScrollStart: () => void;
  busy: boolean;
  hasPendingApproval: boolean;
  onApprovalAction: (action: "allow" | "deny") => void;
  onExit: () => void;
  onScrollPageDown: () => void;
  onScrollPageUp: () => void;
  onSubmit: (text: string) => void;
}

export interface TextInputController {
  cursorIndex: number;
  lines: string[];
  value: string;
}

export function useTextInput(options: UseTextInputOptions): TextInputController {
  const [value, setValue] = React.useState("");
  const [cursorIndex, setCursorIndex] = React.useState(0);
  const preferredColumnRef = React.useRef<number | null>(null);
  const metaPressedRef = React.useRef(false);
  const interruptRequestedAtRef = React.useRef<number | null>(null);

  useInput((input, key) => {
    if (input === "q" && value.length === 0) {
      options.onExit();
      return;
    }

    if (key.escape) {
      metaPressedRef.current = true;
      return;
    }

    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (!options.busy) {
        options.onExit();
        return;
      }

      const lastRequestedAt = interruptRequestedAtRef.current;
      if (lastRequestedAt !== null && now - lastRequestedAt <= 2_000) {
        options.onExit();
        return;
      }

      interruptRequestedAtRef.current = now;
      options.onInterruptRequest();
      return;
    }

    if (key.pageUp) {
      options.onScrollPageUp();
      return;
    }

    if (key.pageDown) {
      options.onScrollPageDown();
      return;
    }

    if (key.ctrl && input === "g") {
      options.onScrollStart();
      return;
    }

    if (key.ctrl && input === "j") {
      options.onScrollEnd();
      return;
    }

    if (key.ctrl && input === "t") {
      options.onToggleActivityCollapse();
      return;
    }

    if (key.ctrl && input === "p") {
      const previous = options.onHistoryPrevious();
      if (previous !== null) {
        setValue(previous);
        setCursorIndex(previous.length);
        preferredColumnRef.current = null;
      }
      return;
    }

    if (key.ctrl && input === "n") {
      const next = options.onHistoryNext();
      if (next !== null) {
        setValue(next);
        setCursorIndex(next.length);
        preferredColumnRef.current = null;
      }
      return;
    }

    if (options.hasPendingApproval && value.length === 0) {
      if (input === "a") {
        options.onApprovalAction("allow");
        return;
      }
      if (input === "d") {
        options.onApprovalAction("deny");
        return;
      }
    }

    if (key.leftArrow) {
      setCursorIndex((current) => Math.max(0, current - 1));
      preferredColumnRef.current = null;
      return;
    }

    if (key.rightArrow) {
      setCursorIndex((current) => Math.min(value.length, current + 1));
      preferredColumnRef.current = null;
      return;
    }

    if (key.upArrow) {
      const next = moveCursorVertical(value, cursorIndex, -1, preferredColumnRef.current);
      setCursorIndex(next.index);
      preferredColumnRef.current = next.preferredColumn;
      return;
    }

    if (key.downArrow) {
      const next = moveCursorVertical(value, cursorIndex, 1, preferredColumnRef.current);
      setCursorIndex(next.index);
      preferredColumnRef.current = next.preferredColumn;
      return;
    }

    const navKey = key as { end?: boolean; home?: boolean };
    if (navKey.home === true) {
      setCursorIndex(getLineStartIndex(value, cursorIndex));
      preferredColumnRef.current = null;
      return;
    }

    if (navKey.end === true) {
      setCursorIndex(getLineEndIndex(value, cursorIndex));
      preferredColumnRef.current = null;
      return;
    }

    if (key.return) {
      if (metaPressedRef.current) {
        const trimmed = value.trim();
        if (trimmed.length > 0 && !options.busy) {
          options.onSubmit(trimmed);
          setValue("");
          setCursorIndex(0);
          preferredColumnRef.current = null;
        }
      } else {
        setValue((current) => insertAt(current, cursorIndex, "\n"));
        setCursorIndex((current) => current + 1);
        preferredColumnRef.current = null;
      }
      metaPressedRef.current = false;
      return;
    }

    metaPressedRef.current = false;

    if (key.ctrl && input === "u") {
      setValue("");
      setCursorIndex(0);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl && input === "a") {
      setCursorIndex(0);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl && input === "e") {
      setCursorIndex(value.length);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl && input === "w") {
      const next = deletePreviousWord(value, cursorIndex);
      if (next.value !== value || next.cursorIndex !== cursorIndex) {
        setValue(next.value);
        setCursorIndex(next.cursorIndex);
        preferredColumnRef.current = null;
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorIndex === 0) {
        return;
      }
      setValue((current) => removeAt(current, cursorIndex - 1));
      setCursorIndex((current) => Math.max(0, current - 1));
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    setValue((current) => insertAt(current, cursorIndex, input));
    setCursorIndex((current) => current + input.length);
    preferredColumnRef.current = null;
  });

  return {
    cursorIndex,
    lines: buildLinesWithCursor(value, cursorIndex),
    value
  };
}

function insertAt(value: string, index: number, fragment: string): string {
  return `${value.slice(0, index)}${fragment}${value.slice(index)}`;
}

function removeAt(value: string, index: number): string {
  return `${value.slice(0, index)}${value.slice(index + 1)}`;
}

function buildLinesWithCursor(value: string, cursorIndex: number): string[] {
  const withCursor = `${value.slice(0, cursorIndex)}|${value.slice(cursorIndex)}`;
  return withCursor.split("\n");
}

export function moveCursorVertical(
  value: string,
  cursorIndex: number,
  direction: -1 | 1,
  preferredColumn: number | null
): { index: number; preferredColumn: number } {
  const lines = value.split("\n");
  const position = getCursorPosition(value, cursorIndex);
  const nextLine = position.line + direction;

  if (nextLine < 0 || nextLine >= lines.length) {
    return {
      index: cursorIndex,
      preferredColumn: preferredColumn ?? position.column
    };
  }

  const targetColumn = preferredColumn ?? position.column;
  const boundedColumn = Math.min(targetColumn, lines[nextLine]?.length ?? 0);
  const nextIndex = getCursorIndexFromLineColumn(lines, nextLine, boundedColumn);

  return {
    index: nextIndex,
    preferredColumn: targetColumn
  };
}

function getCursorPosition(value: string, cursorIndex: number): { line: number; column: number } {
  const lines = value.split("\n");
  let offset = 0;

  for (let line = 0; line < lines.length; line += 1) {
    const lineLength = lines[line]?.length ?? 0;
    const lineEnd = offset + lineLength;
    if (cursorIndex <= lineEnd) {
      return {
        column: cursorIndex - offset,
        line
      };
    }
    offset = lineEnd + 1;
  }

  const lastLine = Math.max(0, lines.length - 1);
  return {
    column: lines[lastLine]?.length ?? 0,
    line: lastLine
  };
}

function getCursorIndexFromLineColumn(lines: string[], line: number, column: number): number {
  let index = 0;
  for (let i = 0; i < line; i += 1) {
    index += (lines[i]?.length ?? 0) + 1;
  }
  return index + column;
}

function getLineStartIndex(value: string, cursorIndex: number): number {
  const lastBreak = value.lastIndexOf("\n", Math.max(0, cursorIndex - 1));
  return lastBreak === -1 ? 0 : lastBreak + 1;
}

function getLineEndIndex(value: string, cursorIndex: number): number {
  const nextBreak = value.indexOf("\n", cursorIndex);
  return nextBreak === -1 ? value.length : nextBreak;
}

export function deletePreviousWord(
  value: string,
  cursorIndex: number
): { value: string; cursorIndex: number } {
  if (cursorIndex <= 0) {
    return { cursorIndex: 0, value };
  }

  let index = cursorIndex;
  while (index > 0 && /\s/u.test(value[index - 1] ?? "")) {
    index -= 1;
  }
  while (index > 0 && !/\s/u.test(value[index - 1] ?? "")) {
    index -= 1;
  }

  return {
    cursorIndex: index,
    value: `${value.slice(0, index)}${value.slice(cursorIndex)}`
  };
}

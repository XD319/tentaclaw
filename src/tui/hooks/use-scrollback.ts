import React from "react";

export interface ScrollbackController {
  atBottom: boolean;
  endIndexExclusive: number;
  pageSize: number;
  startIndex: number;
  scrollToEnd: () => void;
  scrollToStart: () => void;
  scrollToBottom: () => void;
  scrollPageDown: () => void;
  scrollPageUp: () => void;
}

export function useScrollback(totalItems: number, reservedRows = 8): ScrollbackController {
  const [terminalRows, setTerminalRows] = React.useState(() =>
    typeof process.stdout.rows === "number" ? process.stdout.rows : 24
  );

  React.useEffect(() => {
    const onResize = (): void => {
      setTerminalRows(typeof process.stdout.rows === "number" ? process.stdout.rows : 24);
    };
    if (process.stdout.isTTY) {
      process.stdout.on("resize", onResize);
      process.on("SIGWINCH", onResize);
    }
    return () => {
      if (process.stdout.isTTY) {
        process.stdout.off("resize", onResize);
        process.off("SIGWINCH", onResize);
      }
    };
  }, []);

  const pageSize = Math.max(terminalRows - reservedRows, 4);
  const [endIndexExclusive, setEndIndexExclusive] = React.useState(totalItems);
  const previousTotalItemsRef = React.useRef(totalItems);

  React.useEffect(() => {
    const previousTotal = previousTotalItemsRef.current;
    setEndIndexExclusive((previous) => {
      const wasFollowingBottom = previous >= previousTotal;
      if (wasFollowingBottom) {
        return totalItems;
      }
      return Math.min(previous, totalItems);
    });
    previousTotalItemsRef.current = totalItems;
  }, [totalItems]);

  const scrollPageUp = React.useCallback(() => {
    setEndIndexExclusive((current) => Math.max(pageSize, current - pageSize));
  }, [pageSize]);

  const scrollPageDown = React.useCallback(() => {
    setEndIndexExclusive((current) => Math.min(totalItems, current + pageSize));
  }, [pageSize, totalItems]);

  const scrollToBottom = React.useCallback(() => {
    setEndIndexExclusive(totalItems);
  }, [totalItems]);

  const scrollToStart = React.useCallback(() => {
    setEndIndexExclusive(pageSize);
  }, [pageSize]);

  const scrollToEnd = React.useCallback(() => {
    setEndIndexExclusive(totalItems);
  }, [totalItems]);

  const startIndex = Math.max(0, endIndexExclusive - pageSize);
  const atBottom = endIndexExclusive >= totalItems;

  return {
    atBottom,
    endIndexExclusive,
    pageSize,
    scrollToEnd,
    scrollToStart,
    scrollToBottom,
    scrollPageDown,
    scrollPageUp,
    startIndex
  };
}

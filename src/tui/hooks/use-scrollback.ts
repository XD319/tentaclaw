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
  const rows = typeof process.stdout.rows === "number" ? process.stdout.rows : 24;
  const pageSize = Math.max(rows - reservedRows, 4);
  const [endIndexExclusive, setEndIndexExclusive] = React.useState(totalItems);

  React.useEffect(() => {
    setEndIndexExclusive((previous) => {
      if (previous >= totalItems - 1) {
        return totalItems;
      }
      return Math.min(previous, totalItems);
    });
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

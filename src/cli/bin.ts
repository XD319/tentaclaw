#!/usr/bin/env node

const originalEmitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (isSqliteExperimentalWarning(warning, args)) {
    return;
  }

  originalEmitWarning(warning, ...args);
}) as typeof process.emitWarning;

function isSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  const name = typeof warning === "string" ? args.find((arg): arg is string => typeof arg === "string") : warning.name;
  return name === "ExperimentalWarning" && message.includes("SQLite");
}

void import("./index").then(({ main }) => main()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal CLI error: ${message}`);
  process.exitCode = 1;
});

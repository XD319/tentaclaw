#!/usr/bin/env node

const originalEmitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
const MINIMUM_NODE_VERSION = { major: 22, minor: 13, patch: 0 };

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(
    `Fatal CLI error: auto-talon requires Node.js >=22.13.0 because runtime storage uses the built-in node:sqlite module without an experimental flag. Current Node.js version is ${process.versions.node}.`
  );
  process.exitCode = 1;
} else {
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    if (isSqliteExperimentalWarning(warning, args)) {
      return;
    }

    originalEmitWarning(warning, ...args);
  }) as typeof process.emitWarning;

  void import("./index.js").then(({ main }) => main()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fatal CLI error: ${message}`);
    process.exitCode = 1;
  });
}

function isSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  const name = typeof warning === "string" ? args.find((arg): arg is string => typeof arg === "string") : warning.name;
  return name === "ExperimentalWarning" && message.includes("SQLite");
}

function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number(part));
  if (major !== MINIMUM_NODE_VERSION.major) {
    return major > MINIMUM_NODE_VERSION.major;
  }
  if (minor !== MINIMUM_NODE_VERSION.minor) {
    return minor > MINIMUM_NODE_VERSION.minor;
  }
  return patch >= MINIMUM_NODE_VERSION.patch;
}

import type { Provider, ProviderInput, ProviderResponse, ProviderToolCall } from "../types";

interface ScriptedSmokeProviderConfig {
  model?: string;
}

export class ScriptedSmokeProvider implements Provider {
  public readonly name = "scripted-smoke";
  public readonly model: string;

  public constructor(config: ScriptedSmokeProviderConfig = {}) {
    this.model = config.model ?? "scripted-smoke-v1";
  }

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    const smokeTaskId =
      typeof input.task.metadata.smokeTaskId === "string" ? input.task.metadata.smokeTaskId : "";
    const iteration = input.task.currentIteration === 0 ? 1 : input.task.currentIteration;
    const toolMessages = input.messages.filter((message) => message.role === "tool");

    switch (smokeTaskId) {
      case "single_read_project_summary":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Read project summary sources.", [
            readFile(`single-readme-${iteration}`, "README.md", "Read the project overview."),
            readFile(`single-package-${iteration}`, "package.json", "Read project scripts and metadata.")
          ]));
        }

        return Promise.resolve(finalResponse(
          "Project summary complete. README and package.json show a local agent runtime with build and test scripts."
        ));

      case "single_generate_file":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Write the requested release note.", [
            writeFile(
              `single-generate-write-${iteration}`,
              "docs/generated/release-note.md",
              "# Release Note\n\nThis release adds runtime smoke task coverage.\n",
              "Create the requested release note file."
            )
          ]));
        }

        return Promise.resolve(finalResponse("release-note.md created with a short release note."));

      case "single_update_config":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Enable the feature flag.", [
            updateFile(
              `single-update-config-${iteration}`,
              "config/app.json",
              "\"featureFlag\": false",
              "\"featureFlag\": true",
              "Update the featureFlag setting to true."
            )
          ]));
        }

        return Promise.resolve(finalResponse("config/app.json updated and featureFlag is now true."));

      case "single_run_shell":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Run the requested shell command.", [
            shell(`single-run-shell-${iteration}`, "whoami", "Identify the current execution user.")
          ]));
        }

        return Promise.resolve(finalResponse(`Shell command completed. whoami returned: ${extractStdout(toolMessages.at(-1)?.content)}`));

      case "multi_read_then_plan_write":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Read the source files before planning the write.", [
            readFile(`multi-readme-${iteration}`, "README.md", "Read the overview before drafting the summary."),
            readFile(`multi-package-${iteration}`, "package.json", "Read package scripts before drafting the summary."),
            readFile(`multi-config-${iteration}`, "config/app.json", "Read config defaults before drafting the summary.")
          ]));
        }

        if (iteration === 2) {
          return Promise.resolve(toolCallResponse("Write the runtime overview after collecting context.", [
            writeFile(
              `multi-overview-write-${iteration}`,
              "docs/runtime-overview.md",
              "# Runtime Overview\n\nThis workspace contains a local agent runtime, sample config, and smoke-test fixtures.\n",
              "Write the synthesized runtime overview."
            )
          ]));
        }

        return Promise.resolve(finalResponse("runtime-overview.md created after reading README, package.json, and config/app.json."));

      case "multi_write_then_verify":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Create the feature flag file first.", [
            writeFile(
              `multi-write-verify-write-${iteration}`,
              "config/feature.flag.json",
              "{\n  \"enabled\": true,\n  \"source\": \"smoke\"\n}\n",
              "Write the feature flag file before verification."
            )
          ]));
        }

        if (iteration === 2) {
          return Promise.resolve(toolCallResponse("Verify the file content after writing.", [
            readFile(
              `multi-write-verify-read-${iteration}`,
              "config/feature.flag.json",
              "Read back the file to verify the write succeeded."
            )
          ]));
        }

        return Promise.resolve(finalResponse("Verification succeeded. config/feature.flag.json exists and contains the expected JSON."));

      case "multi_fix_after_failed_verification":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Write the initial failing verification state.", [
            writeFile(
              `multi-fix-write-${iteration}`,
              "config/verification.txt",
              "FAIL\n",
              "Create the initial failing verification marker."
            )
          ]));
        }

        if (iteration === 2) {
          return Promise.resolve(toolCallResponse("Run a shell check to inspect the verification state.", [
            shell(
              `multi-fix-check-1-${iteration}`,
              readVerificationCommand(),
              "Inspect whether verification currently reports FAIL or PASS."
            )
          ]));
        }

        if (iteration === 3) {
          return Promise.resolve(toolCallResponse("Repair the failing verification state.", [
            updateFile(
              `multi-fix-update-${iteration}`,
              "config/verification.txt",
              "FAIL",
              "PASS",
              "Replace FAIL with PASS before re-checking."
            )
          ]));
        }

        if (iteration === 4) {
          return Promise.resolve(toolCallResponse("Re-run the verification check after the fix.", [
            shell(
              `multi-fix-check-2-${iteration}`,
              readVerificationCommand(),
              "Confirm the verification marker changed to PASS."
            )
          ]));
        }

        return Promise.resolve(finalResponse("Verification recovered successfully. The status moved from FAIL to PASS after one repair."));

      case "multi_search_patch_verify":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Search for TODO markers first.", [
            searchText(
              `multi-search-${iteration}`,
              "TODO",
              "src",
              "Find TODO markers before applying the patch."
            )
          ]));
        }

        if (iteration === 2) {
          return Promise.resolve(toolCallResponse("Patch the TODO in src/app.ts.", [
            applyPatch(
              `multi-patch-${iteration}`,
              "src/app.ts",
              "TODO: clean up bootstrap",
              "bootstrap is ready for smoke testing",
              "Patch the TODO marker in src/app.ts."
            )
          ]));
        }

        if (iteration === 3) {
          return Promise.resolve(toolCallResponse("Read the file again to verify the patch.", [
            readFile(`multi-patch-verify-${iteration}`, "src/app.ts", "Verify the patched file content.")
          ]));
        }

        return Promise.resolve(finalResponse("TODO cleanup complete. src/app.ts was patched and verified."));

      case "long_cross_file_review_with_compact":
        if (iteration === 1) {
          return Promise.resolve(toolCallResponse("Start the long reviewer pass with README.", [
            readFile(`long-review-readme-${iteration}`, "README.md", "Review the project overview first.")
          ]));
        }

        if (iteration === 2) {
          return Promise.resolve(toolCallResponse("Continue reviewer pass with package.json.", [
            readFile(`long-review-package-${iteration}`, "package.json", "Review scripts and metadata next.")
          ]));
        }

        if (iteration === 3) {
          return Promise.resolve(toolCallResponse("Continue reviewer pass with src/app.ts.", [
            readFile(`long-review-app-${iteration}`, "src/app.ts", "Review the entry module implementation.")
          ]));
        }

        if (iteration === 4) {
          return Promise.resolve(toolCallResponse("Continue reviewer pass with src/runtime.ts.", [
            readFile(`long-review-runtime-${iteration}`, "src/runtime.ts", "Review runtime helper implementation.")
          ]));
        }

        if (iteration === 5) {
          return Promise.resolve(toolCallResponse("Finish reviewer pass with config/app.json.", [
            readFile(`long-review-config-${iteration}`, "config/app.json", "Review the default runtime config.")
          ]));
        }

        return Promise.resolve(finalResponse(
          "Reviewer pass complete. The workspace has coherent docs, scripts, code entry points, and runtime config."
        ));

      case "long_memory_recall_followup": {
        const recalled =
          input.memoryContext.find((fragment) => fragment.scope === "project")?.text ??
          input.memoryContext[0]?.text ??
          "No prior memory recalled.";
        return Promise.resolve(finalResponse(`Follow-up guidance: reuse the earlier smoke verification advice. ${recalled}`));
      }

      case "memory_seed_project":
        return Promise.resolve(finalResponse(
          "Use pnpm and vitest for smoke verification, and keep trace summaries readable for regression review."
        ));

      default:
        return Promise.resolve(finalResponse(`No scripted smoke scenario matched ${smokeTaskId}.`));
    }
  }
}

function toolCallResponse(message: string, toolCalls: ProviderToolCall[]): ProviderResponse {
  return {
    kind: "tool_calls",
    message,
    metadata: {
      modelName: "scripted-smoke-v1",
      providerName: "scripted-smoke",
      retryCount: 0
    },
    toolCalls,
    usage: {
      inputTokens: 12,
      outputTokens: 8
    }
  };
}

function finalResponse(message: string): ProviderResponse {
  return {
    kind: "final",
    message,
    metadata: {
      modelName: "scripted-smoke-v1",
      providerName: "scripted-smoke",
      retryCount: 0
    },
    usage: {
      inputTokens: 8,
      outputTokens: Math.max(8, Math.ceil(message.length / 8))
    }
  };
}

function readFile(toolCallId: string, path: string, reason: string): ProviderToolCall {
  return {
    input: {
      action: "read_file",
      path
    },
    reason,
    toolCallId,
    toolName: "file_read"
  };
}

function searchText(
  toolCallId: string,
  keyword: string,
  path: string,
  reason: string
): ProviderToolCall {
  return {
    input: {
      action: "search_text",
      keyword,
      path
    },
    reason,
    toolCallId,
    toolName: "file_read"
  };
}

function writeFile(
  toolCallId: string,
  path: string,
  content: string,
  reason: string
): ProviderToolCall {
  return {
    input: {
      action: "write_file",
      content,
      overwrite: true,
      path
    },
    reason,
    toolCallId,
    toolName: "file_write"
  };
}

function updateFile(
  toolCallId: string,
  path: string,
  targetText: string,
  newText: string,
  reason: string
): ProviderToolCall {
  return {
    input: {
      action: "update_file",
      newText,
      path,
      replaceAll: false,
      targetText
    },
    reason,
    toolCallId,
    toolName: "file_write"
  };
}

function applyPatch(
  toolCallId: string,
  path: string,
  find: string,
  replace: string,
  reason: string
): ProviderToolCall {
  return {
    input: {
      action: "apply_patch",
      patches: [
        {
          find,
          replace,
          replaceAll: false
        }
      ],
      path
    },
    reason,
    toolCallId,
    toolName: "file_write"
  };
}

function shell(toolCallId: string, command: string, reason: string): ProviderToolCall {
  return {
    input: {
      command
    },
    reason,
    toolCallId,
    toolName: "shell"
  };
}

function extractStdout(content: string | undefined): string {
  if (content === undefined) {
    return "unknown";
  }

  try {
    const parsed = JSON.parse(content) as {
      stdout?: string;
      redacted?: string;
    };
    return (parsed.stdout ?? parsed.redacted ?? "unknown").trim() || "unknown";
  } catch {
    return content.trim() || "unknown";
  }
}

function readVerificationCommand(): string {
  return process.platform === "win32"
    ? "Get-Content config\\verification.txt"
    : "cat config/verification.txt";
}

import { Command } from "commander";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  McpServer,
  McpSkillBridge,
  McpStdioHost,
  McpToolBridge,
  resolveMcpServerConfig
} from "../mcp/index.js";
import {
  buildRepoMap,
  createApplication,
  createDefaultRunOptions,
  resolveDefaultReviewerId,
  initializeWorkspaceFiles,
  RUNTIME_VERSION,
} from "../runtime/index.js";
import { runGitReadOnly } from "../runtime/workspace/git-readonly.js";
import { startDashboardTui, startTui } from "../tui/index.js";
import {
  clearSessionModelSelection,
  formatModelList,
  formatModelStatus,
  resolveModelCommandCwd,
  resolveModelCommandWorkspaceFlag,
  runInteractiveModelWizard,
  setModelSelection
} from "./model-command.js";
import {
  collectOption,
  parseNonNegativeNumberOption,
  parsePositiveIntegerOption,
  resolveSandboxCliOptions,
  type SandboxCommandOptions
} from "./cli-helpers.js";
import { registerEvalCommands } from "./eval-command.js";
import { registerGatewayCommands } from "./gateway-command.js";
import { registerMemoryCommands } from "./memory-command.js";
import { registerProviderCommands } from "./provider-command.js";
import { registerScheduleCommands } from "./schedule-command.js";
import { registerSessionCommands } from "./session-command.js";
import { registerTaskTraceCommands } from "./task-trace-command.js";
import { resolveRuntimeConfig, writeAuxiliarySlot } from "../runtime/runtime-config.js";
import { migrateUserCapabilities } from "../storage/user-capability-migration.js";
import {
  AUXILIARY_SLOTS,
  type AuxiliarySlot
} from "../providers/auxiliary-resolver.js";

import {
  formatDoctorReport,
  formatExperienceDetail,
  formatExperienceList,
  formatExperienceSearch,
  formatProviderStats,
  formatRunError,
  formatSkillDraft,
  formatSkillList,
  formatSkillView,
  formatToolList
} from "./formatters.js";
import type {
  ExperienceQuery,
  ExperienceSourceType,
  ExperienceStatus,
  ExperienceType,
  RuntimeOutputEvent
} from "../types/index.js";
import type { SkillAttachmentKind } from "../types/skill.js";

export async function main(argv = process.argv): Promise<void> {
  const program = new Command();
  program.name("talon").description("Agent Runtime MVP CLI").version("0.1.1");

  program.command("version").description("Show runtime and environment version").action(() => {
    console.log(`auto-talon v${program.version()}`);
    console.log(`runtimeVersion=${RUNTIME_VERSION}`);
    console.log(`node=${process.version}`);
  });

  program
    .command("run")
    .argument("<task>", "Task prompt to execute")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--profile <profile>", "Agent profile", "executor")
    .option("--mode <mode>", "Interaction mode: agent | plan | acceptEdits", "agent")
    .option("--session <sessionId>", "Reuse an existing session id")
    .option("--max-iterations <number>", "Maximum loop iterations", parsePositiveIntegerOption("--max-iterations"))
    .option("--timeout-ms <number>", "Task timeout in milliseconds", parsePositiveIntegerOption("--timeout-ms"))
    .option("--json-events", "Write runtime output events as NDJSON on stderr")
    .action(async (task: string, commandOptions: RunCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const runOptions = createDefaultRunOptions(task, commandOptions.cwd, handle.config);
        runOptions.agentProfileId = commandOptions.profile as typeof runOptions.agentProfileId;
        if (commandOptions.mode === "plan") {
          runOptions.interactionMode = "plan";
          runOptions.agentProfileId = "planner";
        } else if (commandOptions.mode === "acceptEdits") {
          runOptions.interactionMode = "acceptEdits";
        }
        if (commandOptions.session !== undefined) {
          runOptions.sessionId = commandOptions.session;
        }
        if (commandOptions.maxIterations !== undefined) {
          runOptions.maxIterations = commandOptions.maxIterations;
        }
        if (commandOptions.timeoutMs !== undefined) {
          runOptions.timeoutMs = commandOptions.timeoutMs;
        }
        runOptions.onOutputEvent = createCliOutputListener(commandOptions.jsonEvents === true);

        const result = await handle.service.runTask(runOptions);
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
        console.log(formatProviderStats(handle.service.providerStats()));
        if (result.error !== undefined) {
          console.error(`Error: ${formatRunError(result.error)}`);
          process.exitCode = 1;
        }
      } finally {
        handle.close();
      }
    });

  program
    .command("continue")
    .argument("[task]", "Task prompt to continue in a session")
    .option("--last", "Continue the latest session for current user")
    .option("--session <sessionId>", "Continue a specific session id")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--json-events", "Write runtime output events as NDJSON on stderr")
    .action(async (task: string | undefined, commandOptions: { cwd: string; jsonEvents?: boolean; last?: boolean; session?: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const sessionInput =
          commandOptions.session !== undefined && task === undefined
            ? handle.service.listNextActions({ sessionId: commandOptions.session, statuses: ["active", "pending"] })[0]
                ?.title
            : task;
        const result =
          commandOptions.session !== undefined
            ? await (async () => {
                const sessionId = commandOptions.session;
                if (sessionId === undefined) {
                  throw new Error("Session id is required.");
                }
                if (sessionInput === undefined) {
                  throw new Error("No task input or next action found.");
                }
                return handle.service.continueSession(sessionId, sessionInput, {
                  cwd: commandOptions.cwd,
                  onOutputEvent: createCliOutputListener(commandOptions.jsonEvents === true)
                });
              })()
            : commandOptions.last === true
              ? await handle.service.continueLatest(task, {
                  cwd: commandOptions.cwd,
                  onOutputEvent: createCliOutputListener(commandOptions.jsonEvents === true)
                })
              : (() => {
                  throw new Error(
                    "Continue requires --last to resume the latest session or --session <sessionId> to target a session."
                  );
                })();
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Session ID: ${result.task.sessionId ?? "-"}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
        if (result.error !== undefined) {
          console.error(`Error: ${formatRunError(result.error)}`);
          process.exitCode = 1;
        } else if (result.task.status === "failed" || result.task.status === "cancelled") {
          process.exitCode = 1;
        }
      } finally {
        handle.close();
      }
    });

  registerSessionCommands(program);
  registerTaskTraceCommands(program);
  registerScheduleCommands(program);

  const configCommand = program
    .command("config")
    .description("Configuration and environment checks");

  configCommand
    .command("doctor")
    .option("--fix", "Migrate legacy JSON transcripts and finalize thread→session schema")
    .action(async (commandOptions: { fix?: boolean }) => {
      const handle = createApplication(process.cwd(), { allowLegacyWorkspace: true });
      try {
        if (commandOptions.fix === true) {
          const repair = await handle.service.repairLegacyWorkspace();
          if (repair.migratedFiles > 0 || repair.skippedFiles > 0) {
            console.log(
              `Transcript migration: migrated=${repair.migratedFiles} skipped=${repair.skippedFiles}`
            );
          }
          if (repair.remainingIssues.length > 0) {
            console.log("Remaining legacy issues:");
            for (const issue of repair.remainingIssues) {
              console.log(`- ${issue}`);
            }
          }
        }
        console.log(formatDoctorReport(await handle.service.configDoctor()));
      } finally {
        handle.close();
      }
    });

  configCommand
    .command("migrate")
    .description("Migrate legacy capability configuration to the user configuration directory")
    .option("--user-capabilities", "Migrate provider and Web capabilities")
    .option("--apply", "Write changes (default is dry-run)")
    .action((commandOptions: { apply?: boolean; userCapabilities?: boolean }) => {
      if (commandOptions.userCapabilities !== true) throw new Error("Specify --user-capabilities.");
      const result = migrateUserCapabilities(process.cwd(), commandOptions.apply === true);
      console.log(result.applied ? "Migration applied." : "Dry run; no files written.");
      for (const source of result.sourceFiles) console.log(`Source: ${source} (legacy-workspace)`);
      for (const target of result.targetFiles) console.log(`Target: ${target}`);
      for (const envName of result.environmentVariables) console.log(`Required env: ${envName}`);
      for (const warning of result.warnings) console.log(`Warning: ${warning}`);
    });
  program
    .command("doctor")
    .description("Run configuration and environment checks")
    .option("--fix", "Migrate legacy JSON transcripts and finalize thread→session schema")
    .action(async (commandOptions: { fix?: boolean }) => {
      const handle = createApplication(process.cwd(), { allowLegacyWorkspace: true });
      try {
        if (commandOptions.fix === true) {
          const repair = await handle.service.repairLegacyWorkspace();
          if (repair.migratedFiles > 0 || repair.skippedFiles > 0) {
            console.log(
              `Transcript migration: migrated=${repair.migratedFiles} skipped=${repair.skippedFiles}`
            );
          }
          if (repair.remainingIssues.length > 0) {
            console.log("Remaining legacy issues:");
            for (const issue of repair.remainingIssues) {
              console.log(`- ${issue}`);
            }
          }
        }
        console.log(formatDoctorReport(await handle.service.configDoctor()));
      } finally {
        handle.close();
      }
    });

  program
    .command("init")
    .description("Initialize .auto-talon workspace files")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--yes", "Create defaults non-interactively")
    .action((commandOptions: { cwd: string }) => {
      const result = initializeWorkspaceFiles(commandOptions.cwd);
      console.log(`Initialized: ${result.workspaceConfigDir}`);
      console.log(
        result.createdFiles.length === 0
          ? "No new files created."
          : `Created files:\n${result.createdFiles.join("\n")}`
      );
    });

  program
    .command("sandbox")
    .description("Show the resolved sandbox configuration")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action((commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const sandbox = handle.config.sandbox;
        console.log(`Mode: ${sandbox.mode}`);
        console.log(`Profile: ${sandbox.profileName ?? "(default)"}`);
        console.log(`Source: ${sandbox.configSource}`);
        console.log(`Workspace: ${sandbox.workspaceRoot}`);
        console.log(`Write Roots: ${sandbox.writeRoots.join(", ")}`);
        console.log(`Read Roots: ${sandbox.readRoots.join(", ")}`);
      } finally {
        handle.close();
      }
    });

  const skillsCommand = program.command("skills").description("Inspect and manage procedural skills");

  skillsCommand.command("list").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillList(handle.service.listSkills()));
    } finally {
      handle.close();
    }
  });

  skillsCommand
    .command("view")
    .argument("<skill_id>", "Skill identifier")
    .option("--with <kinds>", "Comma-separated attachment kinds: references,templates,scripts,assets")
    .action((skillId: string, commandOptions: { with?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const attachmentKinds = parseAttachmentKinds(commandOptions.with);
        const skill = handle.service.viewSkill(skillId, attachmentKinds);
        console.log(formatSkillView(skill));
        if (skill === null) {
          process.exitCode = 1;
        }
      } finally {
        handle.close();
      }
    });

  skillsCommand.command("enable").argument("<skill_id>", "Skill identifier").action((skillId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillList(handle.service.enableSkill(skillId)));
    } finally {
      handle.close();
    }
  });

  skillsCommand.command("disable").argument("<skill_id>", "Skill identifier").action((skillId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillList(handle.service.disableSkill(skillId)));
    } finally {
      handle.close();
    }
  });

  skillsCommand
    .command("draft")
    .requiredOption("--from-experience <experience_id>", "Accepted or promoted experience id")
    .action((commandOptions: { fromExperience: string }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatSkillDraft(handle.service.createSkillDraftFromExperience(commandOptions.fromExperience)));
      } finally {
        handle.close();
      }
    });

  skillsCommand
    .command("promote")
    .argument("<draft_id>", "Skill draft identifier")
    .option("--target <layer>", "Promotion layer: project, user, or team", "project")
    .action((draftId: string, commandOptions: { target: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const target = commandOptions.target;
        if (target !== "project" && target !== "user" && target !== "team") {
          throw new Error(`Invalid promotion target: ${target}. Use project, user, or team.`);
        }
        console.log(formatSkillDraft(handle.service.promoteSkillDraft(draftId, target)));
      } finally {
        handle.close();
      }
    });

  const registerSkillRollbackCommand = (command: ReturnType<typeof program.command>) => {
    command
      .command("rollback")
      .argument("<skill_id>", "Skill identifier (for example: project:namespace/name)")
      .requiredOption("--reason <text>", "Rollback reason for audit trail")
      .action((skillId: string, commandOptions: { reason: string }) => {
        const handle = createApplication(process.cwd());
        try {
          const rollback = handle.service.rollbackSkillPromotion(skillId, commandOptions.reason);
          console.log(
            `Rolled back ${skillId} to ${rollback.version} (from ${rollback.previousVersion ?? "unknown"})`
          );
        } finally {
          handle.close();
        }
      });
  };
  registerSkillRollbackCommand(skillsCommand);
  registerSkillRollbackCommand(program.command("skill").description("Singular alias for skills"));

  const toolsCommand = program.command("tools").description("Inspect and manage runtime tools");

  toolsCommand.command("list").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatToolList(handle.service.listTools()));
    } finally {
      handle.close();
    }
  });

  toolsCommand.command("enable").argument("<tool_name>", "Tool name").action((toolName: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatToolList(handle.service.enableTool(toolName)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      handle.close();
    }
  });

  toolsCommand.command("disable").argument("<tool_name>", "Tool name").action((toolName: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatToolList(handle.service.disableTool(toolName)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      handle.close();
    }
  });

  const workspaceCommand = program.command("workspace").description("Inspect workspace coding context");

  workspaceCommand
    .command("map")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      printWorkspaceMap(commandOptions.cwd);
    });

  workspaceCommand
    .command("changes")
    .description("Show git status and diff summary for the current workspace")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      console.log(formatWorkspaceChanges(commandOptions.cwd));
    });

  program
    .command("repo")
    .description("Deprecated alias for workspace")
    .command("map")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      console.warn("Warning: `talon repo map` is deprecated; use `talon workspace map`.");
      printWorkspaceMap(commandOptions.cwd);
    });

  workspaceCommand
    .command("rollback")
    .description("Rollback a file write checkpoint")
    .argument("<artifact_id>", "Rollback artifact id or last")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (artifactId: string, commandOptions: { cwd: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const result = await handle.service.rollbackFileArtifact(artifactId);
        console.log(
          result.deleted
            ? `Rolled back by deleting ${result.path}`
            : `Rolled back by restoring ${result.path}`
        );
        console.log(`Artifact: ${result.artifact.artifactId}`);
      } finally {
        handle.close();
      }
    });

  registerProviderCommands(program);

  const modelCommand = program.command("model").description("Configure and inspect models");

  modelCommand
    .command("list")
    .description("List configured models and status")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--json", "Print JSON")
    .option("--session <sessionId>", "Show effective model for a session")
    .action((commandOptions: { cwd: string; json?: boolean; session?: string }, command: Command) => {
      console.log(formatModelList(resolveModelCommandCwd(commandOptions, command), {
        json: commandOptions.json === true,
        ...(commandOptions.session !== undefined ? { sessionId: commandOptions.session } : {})
      }));
    });

  modelCommand
    .command("status")
    .description("Show current model, fallback chain, and auxiliary slots")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--json", "Print JSON")
    .option("--session <sessionId>", "Show effective model for a session")
    .action((commandOptions: { cwd: string; json?: boolean; session?: string }, command: Command) => {
      console.log(formatModelStatus(resolveModelCommandCwd(commandOptions, command), {
        json: commandOptions.json === true,
        ...(commandOptions.session !== undefined ? { sessionId: commandOptions.session } : {})
      }));
    });

  modelCommand
    .command("set")
    .description("Set the default model selection")
    .argument("<selection>", "Provider or provider:model")
    .option("--workspace", "Write to workspace config instead of user config")
    .option("--session <sessionId>", "Write a session-only model override")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (selection: string, commandOptions: { cwd: string; session?: string; workspace?: boolean }, command: Command) => {
      const workspace = resolveModelCommandWorkspaceFlag(commandOptions, command);
      const cwd = resolveModelCommandCwd(commandOptions, command);
      if (commandOptions.session !== undefined && workspace) {
        throw new Error("Choose either --session or --workspace, not both.");
      }
      console.log(await setModelSelection(selection, {
        cwd,
        ...(commandOptions.session !== undefined ? { sessionId: commandOptions.session } : {}),
        workspace
      }));
    });

  modelCommand
    .command("clear")
    .description("Clear a session model override")
    .requiredOption("--session <sessionId>", "Session id")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (commandOptions: { cwd: string; session: string }, command: Command) => {
      console.log(await clearSessionModelSelection(resolveModelCommandCwd(commandOptions, command), commandOptions.session));
    });

  const modelAuxiliaryCommand = modelCommand.command("auxiliary").description("Manage auxiliary model slots");

  modelAuxiliaryCommand
    .command("list")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      const runtimeConfig = resolveRuntimeConfig(commandOptions.cwd);
      for (const [slot, value] of Object.entries(runtimeConfig.auxiliary)) {
        console.log(`${slot}: ${value}`);
      }
    });

  modelAuxiliaryCommand
    .command("set")
    .description("Set an auxiliary slot to auto or provider:model")
    .argument("<slot>", "compression | summarize | vision | title | classify | recallRank")
    .argument("<selection>", "auto or provider:model")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((slot: string, selection: string, commandOptions: { cwd: string }) => {
      const normalizedSlot = slot.trim();
      if (!AUXILIARY_SLOTS.includes(normalizedSlot as AuxiliarySlot)) {
        throw new Error(`Unknown auxiliary slot "${normalizedSlot}".`);
      }
      const configPath = writeAuxiliarySlot(
        commandOptions.cwd,
        normalizedSlot as AuxiliarySlot,
        selection.trim()
      );
      console.log(`Auxiliary slot ${normalizedSlot} set to ${selection.trim()}\nConfig Path: ${configPath}`);
    });

  modelAuxiliaryCommand
    .command("reset")
    .description("Reset an auxiliary slot to auto")
    .argument("<slot>", "compression | summarize | vision | title | classify | recallRank")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((slot: string, commandOptions: { cwd: string }) => {
      const normalizedSlot = slot.trim();
      if (!AUXILIARY_SLOTS.includes(normalizedSlot as AuxiliarySlot)) {
        throw new Error(`Unknown auxiliary slot "${normalizedSlot}".`);
      }
      const configPath = writeAuxiliarySlot(commandOptions.cwd, normalizedSlot as AuxiliarySlot, "auto");
      console.log(`Auxiliary slot ${normalizedSlot} reset to auto\nConfig Path: ${configPath}`);
    });

  modelCommand
    .description("Interactive model picker and default model setup")
    .option("--workspace", "Write to workspace config instead of user config")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (commandOptions: { cwd: string; workspace?: boolean }) => {
      await runInteractiveModelWizard(commandOptions.cwd, commandOptions.workspace === true);
    });

  const budgetCommand = program.command("budget").description("Inspect runtime budget usage");
  budgetCommand
    .command("show")
    .option("--task <taskId>", "Task id")
    .option("--session <sessionId>", "Session id")
    .action((commandOptions: { task?: string; session?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        if (commandOptions.task !== undefined) {
          console.log(JSON.stringify(handle.service.budgetReport("task", commandOptions.task), null, 2));
          return;
        }
        if (commandOptions.session !== undefined) {
          console.log(JSON.stringify(handle.service.budgetReport("session", commandOptions.session), null, 2));
          return;
        }
        console.log("Provide --task <id> or --session <id>.");
      } finally {
        handle.close();
      }
    });

  registerEvalCommands(program);

  registerMemoryCommands(program);

  const experienceCommand = program.command("experience").description("Inspect and review experience assets");

  experienceCommand
    .command("list")
    .option("--type <type>", "Experience type")
    .option("--source <sourceType>", "Experience source type")
    .option("--status <status>", "Experience status")
    .option("--min-value <score>", "Minimum value score", parseNonNegativeNumberOption("--min-value"))
    .option("--task-id <taskId>", "Task id filter")
    .option("--reviewer <reviewerId>", "Reviewer id filter")
    .option("--scope <scope>", "Scope filter")
    .option("--scope-key <scopeKey>", "Scope key filter")
    .option("--limit <number>", "Maximum records", parsePositiveIntegerOption("--limit"))
    .action((commandOptions: ExperienceFilterOptions) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatExperienceList(handle.service.listExperiences(toExperienceQuery(commandOptions))));
      } finally {
        handle.close();
      }
    });

  experienceCommand.command("show").argument("<experience_id>", "Experience identifier").action((experienceId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const experience = handle.service.showExperience(experienceId);
      console.log(formatExperienceDetail(experience));
      if (experience === null) {
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  });

  experienceCommand
    .command("review")
    .argument("<experience_id>", "Experience identifier")
    .argument("<status>", "accepted | rejected | stale")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Review note", "manual experience review")
    .option("--value <score>", "Override value score", parseNonNegativeNumberOption("--value"))
    .action(
      (
        experienceId: string,
        status: "accepted" | "rejected" | "stale",
        commandOptions: { note: string; reviewer?: string; value?: number }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? resolveDefaultReviewerId();
          const reviewed = handle.service.reviewExperience({
            experienceId,
            note: commandOptions.note,
            reviewerId: reviewer,
            status,
            ...(commandOptions.value !== undefined ? { valueScore: commandOptions.value } : {})
          });
          console.log(formatExperienceList([reviewed]));
        } finally {
          handle.close();
        }
      }
    );

  experienceCommand
    .command("promote")
    .argument("<experience_id>", "Experience identifier")
    .argument("<target>", "project_memory | profile_memory | skill_candidate")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Promotion note", "manual experience promotion")
    .action(
      (
        experienceId: string,
        target: "project_memory" | "profile_memory" | "agent_memory" | "skill_candidate",
        commandOptions: { note: string; reviewer?: string }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? resolveDefaultReviewerId();
          const result = handle.service.promoteExperience({
            experienceId,
            note: commandOptions.note,
            reviewerId: reviewer,
            target
          });
          console.log(formatExperienceList([result.experience]));
          console.log(`Promoted Memory: ${result.memory?.memoryId ?? "-"}`);
        } finally {
          handle.close();
        }
      }
    );

  experienceCommand
    .command("search")
    .argument("<query>", "Keyword query")
    .option("--type <type>", "Experience type")
    .option("--source <sourceType>", "Experience source type")
    .option("--status <status>", "Experience status")
    .option("--min-value <score>", "Minimum value score", parseNonNegativeNumberOption("--min-value"))
    .option("--task-id <taskId>", "Task id filter")
    .option("--reviewer <reviewerId>", "Reviewer id filter")
    .option("--scope <scope>", "Scope filter")
    .option("--scope-key <scopeKey>", "Scope key filter")
    .option("--limit <number>", "Maximum records", parsePositiveIntegerOption("--limit"))
    .action((query: string, commandOptions: ExperienceFilterOptions) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatExperienceSearch(handle.service.searchExperiences(query, toExperienceQuery(commandOptions))));
      } finally {
        handle.close();
      }
    });

  program
    .command("tui")
    .description("Open personal assistant terminal UI")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--mode <mode>", "UI mode: chat | ops", "chat")
    .option("--continue", "Resume the latest SQLite session")
    .option("-c", "Alias for --continue")
    .option("--resume <sessionId>", "Resume a session by runtime session_id")
    .action(async (commandOptions: SandboxCommandOptions & { continue?: boolean; c?: boolean; mode?: string; resume?: string }) => {
      if (commandOptions.mode === "ops" || commandOptions.mode === "dashboard") {
        await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
        return;
      }
      await startTui({
        cwd: commandOptions.cwd,
        sandbox: resolveSandboxCliOptions(commandOptions),
        ...(commandOptions.continue === true || commandOptions.c === true ? { continueLatest: true } : {}),
        ...(commandOptions.resume !== undefined ? { resumeSessionId: commandOptions.resume } : {})
      });
    });

  program
    .command("ops")
    .description("Open ops terminal UI for runtime observability and approvals")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions) => {
      await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
    });

  program
    .command("dashboard")
    .description("Compatibility alias for `talon ops`")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions) => {
      await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
    });

  const pluginCommand = program.command("plugin").description("Manage local plugin bundles");

  pluginCommand.command("list").action(() => {
    const plugins = listLocalPlugins(process.cwd());
    if (plugins.length === 0) {
      console.log("No local plugins installed.");
      return;
    }
    for (const plugin of plugins) {
      console.log(`${plugin.name}: ${plugin.path}`);
    }
  });

  pluginCommand
    .command("add")
    .argument("<path>", "Local plugin directory")
    .option("--name <name>", "Installed plugin directory name")
    .action((pluginPath: string, commandOptions: { name?: string }) => {
      const result = addLocalPlugin(process.cwd(), pluginPath, commandOptions.name);
      console.log(`Installed plugin ${result.name} at ${result.path}`);
    });

  pluginCommand.command("remove").argument("<name>", "Installed plugin name").action((name: string) => {
    const removed = removeLocalPlugin(process.cwd(), name);
    console.log(`Removed plugin ${removed.name}`);
  });

  const mcpCommand = program.command("mcp").description("Inspect configured MCP client servers");

  mcpCommand
    .command("list")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const servers = await handle.infrastructure.mcpClientManager.listServers();
        if (servers.length === 0) {
          console.log("No MCP servers discovered. Configure .auto-talon/mcp.config.json first.");
          return;
        }
        for (const server of servers) {
          console.log(`${server.id}: ${server.toolCount} tools`);
          if (server.discoveryError !== null) {
            console.log(`  ! discovery error: ${server.discoveryError}`);
          }
          for (const toolName of server.tools) {
            console.log(`  - ${toolName}`);
          }
        }
      } finally {
        handle.close();
      }
    });

  mcpCommand
    .command("ping")
    .argument("<server_id>", "Configured MCP server id")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (serverId: string, commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        await handle.infrastructure.mcpClientManager.ping(serverId);
        console.log(`MCP server ${serverId} is reachable.`);
      } finally {
        handle.close();
      }
    });

  mcpCommand
    .command("serve")
    .option("--transport <transport>", "MCP transport (stdio)", "stdio")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions & { transport: string }) => {
      if (commandOptions.transport !== "stdio") {
        throw new Error(`Unsupported MCP transport: ${commandOptions.transport}`);
      }
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const config = resolveMcpServerConfig(handle.config.workspaceRoot);
        const server = new McpServer(
          config,
          new McpToolBridge(
            handle.infrastructure.toolOrchestrator,
            handle.config.workspaceRoot,
            config.externalIdentity
          ),
          new McpSkillBridge(handle.infrastructure.skillRegistry)
        );
        const host = new McpStdioHost(server);
        await host.start();
      } finally {
        handle.close();
      }
    });

  registerGatewayCommands(program);

  await program.parseAsync(argv);
}

function createCliOutputListener(jsonEvents: boolean): (event: RuntimeOutputEvent) => void {
  return (event) => {
    if (jsonEvents) {
      console.error(JSON.stringify({ kind: "output", output: event, taskId: event.taskId }));
      return;
    }
    const line = formatCliOutputEvent(event);
    if (line !== null) {
      console.error(line);
    }
  };
}

function formatCliOutputEvent(event: RuntimeOutputEvent): string | null {
  switch (event.eventType) {
    case "task_input":
      return `[task ${event.taskId.slice(0, 8)}] accepted`;
    case "assistant_turn_started":
      return `[turn ${event.payload.iteration}] assistant responding`;
    case "provider_status":
      return `[provider ${event.payload.kind}] ${event.payload.providerName}: ${event.payload.reason}`;
    case "tool_status":
      return `[tool ${event.payload.status}] ${event.payload.toolName}: ${event.payload.summary}`;
    case "approval":
      return `[approval ${event.payload.status}] ${event.payload.toolName}`;
    case "clarification":
      return `[clarification ${event.payload.status}] ${event.payload.question ?? event.payload.promptId}`;
    case "error":
      return `[task ${event.payload.status}] ${event.payload.message}`;
    default:
      return null;
  }
}

interface RunCommandOptions extends SandboxCommandOptions {
  jsonEvents?: boolean;
  maxIterations?: number;
  mode: string;
  profile: string;
  session?: string;
  timeoutMs?: number;
}

interface ExperienceFilterOptions {
  limit?: number;
  minValue?: number;
  reviewer?: string;
  scope?: string;
  scopeKey?: string;
  source?: string;
  status?: string;
  taskId?: string;
  type?: string;
}

function printWorkspaceMap(cwd: string): void {
  const repoMap = buildRepoMap(cwd);
  console.log(repoMap.summary);
  console.log(`Workspace: ${repoMap.workspaceRoot}`);
  console.log(`Languages: ${repoMap.languages.join(", ") || "-"}`);
  console.log(`Package Manager: ${repoMap.packageManager ?? "-"}`);
  console.log(`Important Files: ${repoMap.importantFiles.join(", ") || "-"}`);
  console.log(
    `Scripts: ${
      Object.keys(repoMap.scripts).length === 0
        ? "-"
        : Object.entries(repoMap.scripts).map(([name, command]) => `${name}=${command}`).join("; ")
    }`
  );
}

function formatWorkspaceChanges(cwd: string): string {
  const status = runGitReadOnly(cwd, ["status", "--short"]);
  const diff = runGitReadOnly(cwd, ["diff", "--stat"]);
  const stagedDiff = runGitReadOnly(cwd, ["diff", "--cached", "--stat"]);
  if (status.error !== null) {
    return `Workspace: ${cwd}\nGit: unavailable\nError: ${status.error}`;
  }

  return [
    `Workspace: ${cwd}`,
    "Git status:",
    status.output.trim().length === 0 ? "  clean" : indent(status.output.trimEnd()),
    "Unstaged diff:",
    diff.output.trim().length === 0 ? "  none" : indent(diff.output.trimEnd()),
    "Staged diff:",
    stagedDiff.output.trim().length === 0 ? "  none" : indent(stagedDiff.output.trimEnd())
  ].join("\n");
}


function indent(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => `  ${line}`)
    .join("\n");
}

function toExperienceQuery(options: ExperienceFilterOptions): ExperienceQuery {
  const query: ExperienceQuery = {};
  if (options.type !== undefined) {
    query.type = options.type as ExperienceType;
  }
  if (options.source !== undefined) {
    query.sourceType = options.source as ExperienceSourceType;
  }
  if (options.status !== undefined) {
    query.status = options.status as ExperienceStatus;
  }
  if (options.minValue !== undefined) {
    query.minValueScore = options.minValue;
  }
  if (options.taskId !== undefined) {
    query.taskId = options.taskId;
  }
  if (options.reviewer !== undefined) {
    query.reviewerId = options.reviewer;
  }
  if (options.scope !== undefined) {
    query.scope = options.scope;
  }
  if (options.scopeKey !== undefined) {
    query.scopeKey = options.scopeKey;
  }
  if (options.limit !== undefined) {
    query.limit = options.limit;
  }
  return query;
}

function parseAttachmentKinds(value: string | undefined): SkillAttachmentKind[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value.split(",").map((entry) => {
    const kind = entry.trim();
    if (
      kind !== "references" &&
      kind !== "templates" &&
      kind !== "scripts" &&
      kind !== "assets"
    ) {
      throw new Error(`Unsupported skill attachment kind: ${kind}`);
    }
    return kind;
  });
}

function listLocalPlugins(cwd: string): Array<{ name: string; path: string }> {
  const root = localPluginsRoot(cwd);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(root, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function addLocalPlugin(cwd: string, pluginPath: string, name: string | undefined): { name: string; path: string } {
  const source = resolve(pluginPath);
  if (!existsSync(join(source, ".codex-plugin", "plugin.json"))) {
    throw new Error(`Plugin ${source} must contain .codex-plugin/plugin.json.`);
  }
  const pluginName = name ?? basename(source);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(pluginName)) {
    throw new Error(`Invalid plugin name: ${pluginName}`);
  }
  const root = localPluginsRoot(cwd);
  mkdirSync(root, { recursive: true });
  const target = join(root, pluginName);
  if (existsSync(target)) {
    throw new Error(`Plugin already installed: ${pluginName}`);
  }
  cpSync(source, target, { recursive: true });
  return {
    name: pluginName,
    path: target
  };
}

function removeLocalPlugin(cwd: string, name: string): { name: string } {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(name)) {
    throw new Error(`Invalid plugin name: ${name}`);
  }
  const target = join(localPluginsRoot(cwd), name);
  if (!existsSync(target)) {
    throw new Error(`Plugin not installed: ${name}`);
  }
  rmSync(target, { recursive: true, force: true });
  return { name };
}

function localPluginsRoot(cwd: string): string {
  return join(resolve(cwd), ".auto-talon", "plugins");
}


#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { Command } from "commander";

import { startLocalWebhookGateway } from "../gateway";
import { replayTaskById, runBetaReadinessCheck, runEvalReport } from "../diagnostics";
import type { SupportedProviderName } from "../providers";
import { buildRepoMap, createApplication, createDefaultRunOptions, type ResolveAppConfigOptions } from "../runtime";
import { formatSmokeSuiteReport, runSmokeSuite } from "../testing";
import { startDashboardTui, startTui } from "../tui";

import {
  formatApprovalList,
  formatAuditLog,
  formatBetaReadinessReport,
  formatCurrentProvider,
  formatDoctorReport,
  formatEvalReport,
  formatExperienceDetail,
  formatExperienceList,
  formatExperienceSearch,
  formatMemoryList,
  formatMemoryScope,
  formatProviderCatalog,
  formatProviderHealth,
  formatProviderStats,
  formatReplayReport,
  formatRunError,
  formatSkillDraft,
  formatSkillList,
  formatSkillView,
  formatSnapshot,
  formatTask,
  formatTaskList,
  formatTaskTimeline,
  formatTrace,
  formatTraceContextDebug
} from "./formatters";
import type { ExperienceQuery, ExperienceSourceType, ExperienceStatus, ExperienceType } from "../types";
import type { SkillAttachmentKind } from "../types/skill";

async function main(): Promise<void> {
  const program = new Command();
  program.name("agent").description("Agent Runtime MVP CLI").version("0.1.0");

  program
    .command("run")
    .argument("<task>", "Task prompt to execute")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--profile <profile>", "Agent profile", "executor")
    .option("--max-iterations <number>", "Maximum loop iterations")
    .option("--timeout-ms <number>", "Task timeout in milliseconds")
    .action(async (task: string, commandOptions: RunCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const runOptions = createDefaultRunOptions(task, commandOptions.cwd, handle.config);
        runOptions.agentProfileId = commandOptions.profile as typeof runOptions.agentProfileId;
        if (commandOptions.maxIterations !== undefined) {
          runOptions.maxIterations = Number(commandOptions.maxIterations);
        }
        if (commandOptions.timeoutMs !== undefined) {
          runOptions.timeoutMs = Number(commandOptions.timeoutMs);
        }

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

  const taskCommand = program.command("task").description("Inspect persisted tasks");

  taskCommand.command("list").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTaskList(handle.service.listTasks()));
    } finally {
      handle.close();
    }
  });

  taskCommand.command("show").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const result = handle.service.showTask(taskId);
      if (result.task === null) {
        console.error(`Task ${taskId} not found.`);
        process.exitCode = 1;
        return;
      }

      console.log(formatTask(result.task, result.toolCalls, result.approvals));
    } finally {
      handle.close();
    }
  });

  taskCommand.command("timeline").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTaskTimeline(handle.service.taskTimeline(taskId)));
    } finally {
      handle.close();
    }
  });

  const traceCommand = program.command("trace").description("Inspect persisted trace data");

  traceCommand.argument("[task_id]", "Task identifier").action((taskId?: string) => {
    if (taskId === undefined) {
      console.error("Task id is required.");
      process.exitCode = 1;
      return;
    }

    const handle = createApplication(process.cwd());
    try {
      console.log(formatTrace(handle.service.traceTask(taskId)));
    } finally {
      handle.close();
    }
  });

  traceCommand.command("context").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTraceContextDebug(handle.service.traceTaskContext(taskId)));
    } finally {
      handle.close();
    }
  });

  program.command("audit").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatAuditLog(handle.service.auditTask(taskId)));
    } finally {
      handle.close();
    }
  });

  const approveCommand = program.command("approve").description("Inspect and resolve approvals");

  approveCommand.command("pending").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatApprovalList(handle.service.listPendingApprovals()));
    } finally {
      handle.close();
    }
  });

  approveCommand
    .command("allow")
    .argument("<approval_id>", "Approval identifier")
    .option("--reviewer <reviewer>", "Reviewer id")
    .action(async (approvalId: string, commandOptions: { reviewer?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const reviewerId =
          commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
        const result = await handle.service.resolveApproval(approvalId, "allow", reviewerId);
        console.log(`Approval: ${result.approval.approvalId} ${result.approval.status}`);
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
      } finally {
        handle.close();
      }
    });

  approveCommand
    .command("deny")
    .argument("<approval_id>", "Approval identifier")
    .option("--reviewer <reviewer>", "Reviewer id")
    .action(async (approvalId: string, commandOptions: { reviewer?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const reviewerId =
          commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
        const result = await handle.service.resolveApproval(approvalId, "deny", reviewerId);
        console.log(`Approval: ${result.approval.approvalId} ${result.approval.status}`);
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Status: ${result.task.status}`);
      } finally {
        handle.close();
      }
    });

  program
    .command("config")
    .description("Configuration and environment checks")
    .command("doctor")
    .action(async () => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatDoctorReport(await handle.service.configDoctor()));
      } finally {
        handle.close();
      }
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

  skillsCommand.command("promote").argument("<draft_id>", "Skill draft identifier").action((draftId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillDraft(handle.service.promoteSkillDraft(draftId)));
    } finally {
      handle.close();
    }
  });

  program
    .command("repo")
    .description("Inspect repository coding context")
    .command("map")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      const repoMap = buildRepoMap(commandOptions.cwd);
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
    });

  program
    .command("rollback")
    .description("Rollback a file_write checkpoint")
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

  const providerCommand = program.command("provider").description("Inspect and test providers");

  providerCommand.command("list").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(
        formatProviderCatalog(handle.service.currentProvider().name, handle.service.listProviders())
      );
    } finally {
      handle.close();
    }
  });

  providerCommand.command("current").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCurrentProvider(handle.service.currentProvider()));
    } finally {
      handle.close();
    }
  });

  providerCommand.command("test").action(async () => {
    const handle = createApplication(process.cwd());
    try {
      const report = await handle.service.testCurrentProvider();
      console.log(formatProviderHealth(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  });

  providerCommand.command("stats").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatProviderStats(handle.service.providerStats()));
    } finally {
      handle.close();
    }
  });

  const smokeCommand = program.command("smoke").description("Run fixed runtime smoke tasks");

  program
    .command("replay")
    .argument("<task_id>", "Task identifier")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--from-iteration <number>", "Replay starting from this iteration", "1")
    .option("--provider <mode>", "Replay provider mode: current | mock", "current")
    .action(
      async (
        taskId: string,
        commandOptions: {
          cwd: string;
          fromIteration: string;
          provider: "current" | "mock";
        }
      ) => {
        const report = await replayTaskById(taskId, {
          cwd: commandOptions.cwd,
          fromIteration: Number(commandOptions.fromIteration),
          providerMode: commandOptions.provider
        });
        console.log(formatReplayReport(report));
        if (report.replayTask.status === "failed" || report.replayTask.status === "cancelled") {
          process.exitCode = 1;
        }
      }
    );

  const evalCommand = program.command("eval").description("Run minimal eval and beta readiness checks");

  evalCommand
    .command("run")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--json", "Print JSON instead of text")
    .option("--output <path>", "Write the report to a file")
    .action(
      async (commandOptions: {
        fixture?: string;
        json?: boolean;
        output?: string;
        provider: SupportedProviderName | "scripted-smoke";
        tasks?: string;
      }) => {
        const report = await runEvalReport({
          ...(commandOptions.fixture !== undefined
            ? { fixturePath: commandOptions.fixture }
            : {}),
          providerName: commandOptions.provider,
          taskIds:
            commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
        });
        const output = commandOptions.json === true
          ? JSON.stringify(report, null, 2)
          : formatEvalReport(report);
        if (commandOptions.output !== undefined) {
          writeFileSync(commandOptions.output, `${output}\n`, "utf8");
        } else {
          console.log(output);
        }
        if (report.successRate < 1) {
          process.exitCode = 1;
        }
      }
    );

  evalCommand
    .command("beta")
    .option("--provider <provider>", "Provider to use for sample eval: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--min-success-rate <number>", "Minimum acceptable task success rate", "0.8")
    .action(
      async (commandOptions: {
        minSuccessRate: string;
        provider: SupportedProviderName | "scripted-smoke";
      }) => {
        const report = await runBetaReadinessCheck({
          minimumSuccessRate: Number(commandOptions.minSuccessRate),
          providerName: commandOptions.provider
        });
        console.log(formatBetaReadinessReport(report));
        if (!report.allPassed) {
          process.exitCode = 1;
        }
      }
    );

  smokeCommand
    .command("run")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated smoke task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--no-auto-approve", "Do not auto-resolve approvals during smoke runs")
    .action(
      async (commandOptions: {
        autoApprove: boolean;
        fixture?: string;
        provider: SupportedProviderName | "scripted-smoke";
        tasks?: string;
      }) => {
        const report = await runSmokeSuite({
          autoApprove: commandOptions.autoApprove,
          ...(commandOptions.fixture !== undefined
            ? { fixturePath: commandOptions.fixture }
            : {}),
          providerName: commandOptions.provider,
          taskIds:
            commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
        });
        console.log(formatSmokeSuiteReport(report));
        if (report.failedCount > 0) {
          process.exitCode = 1;
        }
      }
    );

  const memoryCommand = program.command("memory").description("Inspect governed memories");

  memoryCommand.command("list").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatMemoryList(handle.service.listMemories()));
    } finally {
      handle.close();
    }
  });

  memoryCommand
    .command("show")
    .argument("<scope>", "Memory scope: session | project | agent")
    .option("--scope-key <key>", "Explicit scope key")
    .option("--task-id <taskId>", "Task id for session scope")
    .option("--cwd <path>", "Workspace path for project scope", process.cwd())
    .option("--profile <profile>", "Agent profile for agent scope", "executor")
    .option("--user <user>", "User id for agent scope")
    .action(
      (
        scope: "session" | "project" | "agent",
        commandOptions: {
          scopeKey?: string;
          taskId?: string;
          cwd: string;
          profile: string;
          user?: string;
        }
      ) => {
        const handle = createApplication(commandOptions.cwd);
        try {
          const scopeKey = resolveScopeKey(scope, {
            cwd: commandOptions.cwd,
            profile: commandOptions.profile,
            scopeKey: commandOptions.scopeKey,
            taskId: commandOptions.taskId,
            user: commandOptions.user
          });
          const result = handle.service.showMemoryScope(scope, scopeKey);
          console.log(formatMemoryScope(scope, scopeKey, result.memories, result.snapshots));
        } finally {
          handle.close();
        }
      }
    );

  const snapshotCommand = memoryCommand.command("snapshot").description("Manage memory snapshots");

  snapshotCommand
    .command("create")
    .argument("<scope>", "Memory scope: session | project | agent")
    .option("--label <label>", "Snapshot label", "manual-snapshot")
    .option("--scope-key <key>", "Explicit scope key")
    .option("--task-id <taskId>", "Task id for session scope")
    .option("--cwd <path>", "Workspace path for project scope", process.cwd())
    .option("--profile <profile>", "Agent profile for agent scope", "executor")
    .option("--user <user>", "User id for agent scope")
    .option("--reviewer <reviewer>", "Snapshot creator id")
    .action(
      (
        scope: "session" | "project" | "agent",
        commandOptions: {
          cwd: string;
          label: string;
          profile: string;
          reviewer?: string;
          scopeKey?: string;
          taskId?: string;
          user?: string;
        }
      ) => {
        const handle = createApplication(commandOptions.cwd);
        try {
          const scopeKey = resolveScopeKey(scope, {
            cwd: commandOptions.cwd,
            profile: commandOptions.profile,
            scopeKey: commandOptions.scopeKey,
            taskId: commandOptions.taskId,
            user: commandOptions.user
          });
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const snapshot = handle.service.createMemorySnapshot(
            scope,
            scopeKey,
            commandOptions.label,
            reviewer
          );
          console.log(formatSnapshot(snapshot));
        } finally {
          handle.close();
        }
      }
    );

  memoryCommand
    .command("review")
    .argument("<memory_id>", "Memory identifier")
    .argument("<status>", "verified | rejected | stale")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Review note", "manual memory review")
    .action(
      (
        memoryId: string,
        status: "verified" | "rejected" | "stale",
        commandOptions: { note: string; reviewer?: string }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const reviewed = handle.service.reviewMemory(
            memoryId,
            status,
            reviewer,
            commandOptions.note
          );
          console.log(formatMemoryList([reviewed]));
        } finally {
          handle.close();
        }
      }
    );

  const experienceCommand = program.command("experience").description("Inspect and review experience assets");

  experienceCommand
    .command("list")
    .option("--type <type>", "Experience type")
    .option("--source <sourceType>", "Experience source type")
    .option("--status <status>", "Experience status")
    .option("--min-value <score>", "Minimum value score")
    .option("--task-id <taskId>", "Task id filter")
    .option("--reviewer <reviewerId>", "Reviewer id filter")
    .option("--scope <scope>", "Scope filter")
    .option("--scope-key <scopeKey>", "Scope key filter")
    .option("--limit <number>", "Maximum records")
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
    .option("--value <score>", "Override value score")
    .action(
      (
        experienceId: string,
        status: "accepted" | "rejected" | "stale",
        commandOptions: { note: string; reviewer?: string; value?: string }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const reviewed = handle.service.reviewExperience({
            experienceId,
            note: commandOptions.note,
            reviewerId: reviewer,
            status,
            ...(commandOptions.value !== undefined ? { valueScore: Number(commandOptions.value) } : {})
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
    .argument("<target>", "project_memory | agent_memory | skill_candidate")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Promotion note", "manual experience promotion")
    .action(
      (
        experienceId: string,
        target: "project_memory" | "agent_memory" | "skill_candidate",
        commandOptions: { note: string; reviewer?: string }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
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
    .option("--min-value <score>", "Minimum value score")
    .option("--task-id <taskId>", "Task id filter")
    .option("--reviewer <reviewerId>", "Reviewer id filter")
    .option("--scope <scope>", "Scope filter")
    .option("--scope-key <scopeKey>", "Scope key filter")
    .option("--limit <number>", "Maximum records")
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
    .description("Open chat-style terminal UI")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--resume <sessionId>", "Resume a saved session from .auto-talon/sessions")
    .action(async (commandOptions: SandboxCommandOptions & { resume?: string }) => {
      await startTui({
        cwd: commandOptions.cwd,
        sandbox: resolveSandboxCliOptions(commandOptions),
        ...(commandOptions.resume !== undefined ? { resumeSessionId: commandOptions.resume } : {})
      });
    });

  program
    .command("dashboard")
    .description("Open dashboard terminal UI for observability and approvals")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions) => {
      await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
    });

  program
    .command("gateway")
    .description("Run minimal external gateway adapters")
    .command("serve-webhook")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to bind", "7070")
    .action(async (commandOptions: SandboxCommandOptions & { host: string; port: string }) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      const gatewayHandle = await startLocalWebhookGateway(handle, {
        host: commandOptions.host,
        port: Number(commandOptions.port)
      });

      console.log(
        `Local webhook adapter ${gatewayHandle.adapter.descriptor.adapterId} listening on http://${commandOptions.host}:${commandOptions.port}`
      );
      console.log("POST /tasks to submit work, GET /tasks/:taskId to inspect, GET /tasks/:taskId/events for SSE.");

      const shutdown = async (): Promise<void> => {
        await gatewayHandle.manager.stopAll();
        handle.close();
        process.exit(0);
      };

      process.once("SIGINT", () => {
        void shutdown();
      });
      process.once("SIGTERM", () => {
        void shutdown();
      });
    });

  await program.parseAsync(process.argv);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal CLI error: ${message}`);
  process.exitCode = 1;
});

interface SandboxCommandOptions {
  cwd: string;
  sandboxMode?: string;
  sandboxProfile?: string;
  writeRoot?: string[];
}

interface RunCommandOptions extends SandboxCommandOptions {
  maxIterations?: string;
  profile: string;
  timeoutMs?: string;
}

interface ExperienceFilterOptions {
  limit?: string;
  minValue?: string;
  reviewer?: string;
  scope?: string;
  scopeKey?: string;
  source?: string;
  status?: string;
  taskId?: string;
  type?: string;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveSandboxCliOptions(options: SandboxCommandOptions): ResolveAppConfigOptions {
  return {
    ...(options.sandboxMode === "local" || options.sandboxMode === "docker"
      ? { sandboxMode: options.sandboxMode }
      : {}),
    ...(options.sandboxProfile !== undefined ? { sandboxProfile: options.sandboxProfile } : {}),
    ...(options.writeRoot !== undefined ? { writeRoots: options.writeRoot } : {})
  };
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
    query.minValueScore = Number(options.minValue);
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
    query.limit = Number(options.limit);
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

function resolveScopeKey(
  scope: "session" | "project" | "agent",
  options: {
    cwd: string;
    profile: string;
    scopeKey: string | undefined;
    taskId: string | undefined;
    user: string | undefined;
  }
): string {
  if (options.scopeKey !== undefined) {
    return options.scopeKey;
  }

  if (scope === "session") {
    if (options.taskId === undefined) {
      throw new Error("Session scope requires --task-id or --scope-key.");
    }

    return options.taskId;
  }

  if (scope === "project") {
    return options.cwd;
  }

  const userId = options.user ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
  return `${userId}:${options.profile}`;
}

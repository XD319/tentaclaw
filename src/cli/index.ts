import { writeFileSync } from "node:fs";

import { Command } from "commander";

import {
  createGatewayRuntime,
  createFeishuGatewayPlugin,
  startFeishuGateway,
  startLocalWebhookGateway,
  GatewayManager,
  LocalWebhookAdapter
} from "../gateway/index.js";
import {
  McpServer,
  McpSkillBridge,
  McpStdioHost,
  McpToolBridge,
  resolveMcpServerConfig
} from "../mcp/index.js";
import { replayTaskById, runBetaReadinessCheck, runEvalReport, runReleaseChecklist } from "../diagnostics/index.js";
import type { SupportedProviderName } from "../providers/index.js";
import {
  buildRepoMap,
  createApplication,
  createDefaultRunOptions,
  initializeWorkspaceFiles,
  type ResolveAppConfigOptions
} from "../runtime/index.js";
import { formatSmokeSuiteReport, runSmokeSuite } from "../testing/index.js";
import { startDashboardTui, startTui } from "../tui/index.js";

import {
  formatApprovalList,
  formatAuditLog,
  formatBetaReadinessReport,
  formatCommitmentDetail,
  formatCommitmentList,
  formatCurrentProvider,
  formatDoctorReport,
  formatEvalReport,
  formatReleaseChecklistReport,
  formatExperienceDetail,
  formatExperienceList,
  formatExperienceSearch,
  formatInboxDetail,
  formatInboxList,
  formatMemoryList,
  formatMemoryScope,
  formatNextActionList,
  formatProviderCatalog,
  formatProviderHealth,
  formatProviderStats,
  formatScheduleDetail,
  formatScheduleList,
  formatScheduleRunList,
  formatReplayReport,
  formatRunError,
  formatSkillDraft,
  formatSkillList,
  formatSkillView,
  formatSnapshot,
  formatTask,
  formatTaskList,
  formatTaskTimeline,
  formatThreadDetail,
  formatThreadList,
  formatThreadSnapshot,
  formatThreadSnapshotList,
  formatTrace,
  formatTraceContextDebug,
  summarizeAudit,
  summarizeTrace
} from "./formatters.js";
import type {
  CommitmentRecord,
  ExperienceQuery,
  ExperienceSourceType,
  ExperienceStatus,
  ExperienceType
} from "../types/index.js";
import type { InboundMessageAdapter } from "../types/index.js";
import type { SkillAttachmentKind } from "../types/skill.js";

export async function main(argv = process.argv): Promise<void> {
  const program = new Command();
  program.name("talon").description("Agent Runtime MVP CLI").version("0.1.0");

  program.command("version").description("Show runtime and environment version").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(`auto-talon v${program.version()}`);
      console.log(`runtimeVersion=${handle.config.runtimeVersion}`);
      console.log(`node=${process.version}`);
    } finally {
      handle.close();
    }
  });

  program
    .command("run")
    .argument("<task>", "Task prompt to execute")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--profile <profile>", "Agent profile", "executor")
    .option("--thread <threadId>", "Reuse an existing thread id")
    .option("--max-iterations <number>", "Maximum loop iterations")
    .option("--timeout-ms <number>", "Task timeout in milliseconds")
    .action(async (task: string, commandOptions: RunCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const runOptions = createDefaultRunOptions(task, commandOptions.cwd, handle.config);
        runOptions.agentProfileId = commandOptions.profile as typeof runOptions.agentProfileId;
        if (commandOptions.thread !== undefined) {
          runOptions.threadId = commandOptions.thread;
        }
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

  program
    .command("continue")
    .argument("[task]", "Task prompt to continue in a thread")
    .option("--last", "Continue the latest thread for current user")
    .option("--thread <threadId>", "Continue a specific thread id")
    .option("--cwd <path>", "Working directory", process.cwd())
    .action(async (task: string | undefined, commandOptions: { cwd: string; last?: boolean; thread?: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const threadInput =
          commandOptions.thread !== undefined && task === undefined
            ? handle.service.listNextActions({ threadId: commandOptions.thread, statuses: ["active", "pending"] })[0]
                ?.title
            : task;
        const result =
          commandOptions.thread !== undefined
            ? await (async () => {
                if (threadInput === undefined) {
                  throw new Error("No task input or next action found.");
                }
                return handle.service.continueThread(commandOptions.thread, threadInput, {
                  cwd: commandOptions.cwd
                });
              })()
            : commandOptions.last === true
              ? await handle.service.continueLatest(task, { cwd: commandOptions.cwd })
              : await handle.service.continueLatest(task, { cwd: commandOptions.cwd });
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Thread ID: ${result.task.threadId ?? "-"}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
      } finally {
        handle.close();
      }
    });

  const taskCommand = program.command("task").description("Inspect persisted tasks");

  const threadCommand = program.command("thread").description("Inspect persisted threads");
  threadCommand
    .command("list")
    .option("--status <status>", "Filter status: active | archived | deleted")
    .option("--json", "Print JSON")
    .action((commandOptions: { json?: boolean; status?: "active" | "archived" | "deleted" }) => {
      const handle = createApplication(process.cwd());
      try {
        const threads = handle.service.listThreads(commandOptions.status);
        console.log(
          commandOptions.json === true ? JSON.stringify(threads, null, 2) : formatThreadList(threads)
        );
      } finally {
        handle.close();
      }
    });
  threadCommand.command("show").argument("<thread_id>", "Thread identifier").action((threadId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const result = handle.service.showThread(threadId);
      if (result.thread === null) {
        console.error(`Thread ${threadId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(
        formatThreadDetail(
          result.thread,
          result.runs,
          result.lineage,
          result.inboxItems,
          result.commitments,
          result.nextActions,
          result.state
        )
      );
    } finally {
      handle.close();
    }
  });
  threadCommand.command("archive").argument("<thread_id>", "Thread identifier").action((threadId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const thread = handle.service.archiveThread(threadId);
      console.log(`Archived thread: ${thread.threadId}`);
    } finally {
      handle.close();
    }
  });
  threadCommand
    .command("snapshots")
    .argument("<thread_id>", "Thread identifier")
    .action((threadId: string) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatThreadSnapshotList(handle.service.listThreadSnapshots(threadId)));
      } finally {
        handle.close();
      }
    });
  threadCommand
    .command("snapshot")
    .argument("<snapshot_id>", "Snapshot identifier")
    .action((snapshotId: string) => {
      const handle = createApplication(process.cwd());
      try {
        const snapshot = handle.service.showThreadSnapshot(snapshotId);
        if (snapshot === null) {
          console.error(`Thread snapshot ${snapshotId} not found.`);
          process.exitCode = 1;
          return;
        }
        console.log(formatThreadSnapshot(snapshot));
      } finally {
        handle.close();
      }
    });

  taskCommand.command("list").option("--json", "Print JSON").action((commandOptions: { json?: boolean }) => {
    const handle = createApplication(process.cwd());
    try {
      const tasks = handle.service.listTasks();
      console.log(commandOptions.json === true ? JSON.stringify(tasks, null, 2) : formatTaskList(tasks));
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

      console.log(
        formatTask(result.task, result.toolCalls, result.approvals, result.scheduleRuns, result.inboxItems)
      );
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

  const scheduleCommand = program.command("schedule").description("Manage scheduled background jobs");
  scheduleCommand
    .command("create")
    .argument("<input>", "Scheduled task prompt")
    .requiredOption("--name <name>", "Schedule display name")
    .option("--every <duration>", "Recurring interval, e.g. 5m, 1h, 1d")
    .option("--at <iso>", "One-shot run time in ISO-8601")
    .option("--cron <expression>", "Cron expression")
    .option("--timezone <timezone>", "IANA timezone for cron, e.g. Asia/Shanghai")
    .option("--thread <thread_id>", "Continue an existing thread")
    .option("--profile <profile>", "Agent profile id", "executor")
    .option("--cwd <cwd>", "Working directory", process.cwd())
    .option("--max-attempts <num>", "Max retry attempts", "3")
    .option("--backoff-base <ms>", "Backoff base milliseconds", "5000")
    .option("--backoff-max <ms>", "Backoff max milliseconds", "300000")
    .action((input: string, commandOptions: Record<string, string | undefined>) => {
      const handle = createApplication(process.cwd());
      try {
        const ownerUserId = process.env.USERNAME ?? process.env.USER ?? "local-user";
        const name = commandOptions.name ?? "scheduled-run";
        const cwd = commandOptions.cwd ?? process.cwd();
        const profile = (commandOptions.profile ?? "executor") as "executor" | "planner" | "reviewer";
        const schedule = handle.service.createSchedule({
          agentProfileId: profile,
          backoffBaseMs: Number.parseInt(commandOptions.backoffBase ?? "5000", 10),
          backoffMaxMs: Number.parseInt(commandOptions.backoffMax ?? "300000", 10),
          cwd,
          input,
          maxAttempts: Number.parseInt(commandOptions.maxAttempts ?? "3", 10),
          name,
          ownerUserId,
          providerName: handle.config.provider.name,
          ...(commandOptions.cron !== undefined ? { cron: commandOptions.cron } : {}),
          ...(commandOptions.every !== undefined ? { every: commandOptions.every } : {}),
          ...(commandOptions.at !== undefined ? { runAt: commandOptions.at } : {}),
          ...(commandOptions.thread !== undefined ? { threadId: commandOptions.thread } : {}),
          ...(commandOptions.timezone !== undefined ? { timezone: commandOptions.timezone } : {})
        });
        console.log(formatScheduleDetail(schedule));
      } finally {
        handle.close();
      }
    });
  scheduleCommand
    .command("list")
    .option("--status <status>", "Filter status: active | paused | completed | archived")
    .action((commandOptions: { status?: "active" | "paused" | "completed" | "archived" }) => {
      const handle = createApplication(process.cwd());
      try {
        const query = commandOptions.status === undefined ? undefined : { status: commandOptions.status };
        console.log(formatScheduleList(handle.service.listSchedules(query)));
      } finally {
        handle.close();
      }
    });
  scheduleCommand.command("show").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const schedule = handle.service.showSchedule(scheduleId);
      if (schedule === null) {
        console.error(`Schedule ${scheduleId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(formatScheduleDetail(schedule));
    } finally {
      handle.close();
    }
  });
  scheduleCommand.command("pause").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatScheduleDetail(handle.service.pauseSchedule(scheduleId)));
    } finally {
      handle.close();
    }
  });
  scheduleCommand.command("resume").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatScheduleDetail(handle.service.resumeSchedule(scheduleId)));
    } finally {
      handle.close();
    }
  });
  scheduleCommand.command("run-now").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const run = handle.service.runScheduleNow(scheduleId);
      console.log(formatScheduleRunList([run]));
    } finally {
      handle.close();
    }
  });
  scheduleCommand
    .command("runs")
    .argument("<schedule_id>")
    .option("--status <status>", "Filter status")
    .option("--tail <count>", "Number of latest runs", "20")
    .action((scheduleId: string, commandOptions: { status?: string; tail: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const parsedStatus = commandOptions.status as
          | "queued"
          | "running"
          | "waiting_approval"
          | "blocked"
          | "completed"
          | "failed"
          | "cancelled"
          | undefined;
        const query =
          parsedStatus === undefined
            ? { tail: Number.parseInt(commandOptions.tail, 10) }
            : { status: parsedStatus, tail: Number.parseInt(commandOptions.tail, 10) };
        const runs = handle.service.listScheduleRuns(scheduleId, query);
        console.log(formatScheduleRunList(runs));
      } finally {
        handle.close();
      }
    });
  scheduleCommand.command("run").description("Run scheduler daemon").action(async () => {
    const handle = createApplication(process.cwd(), {
      scheduler: { autoStart: true }
    });
    console.log("Scheduler started. Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        handle.close();
        resolve();
      });
    });
  });

  traceCommand
    .argument("[task_id]", "Task identifier")
    .option("--summary", "Print summary instead of full trace")
    .action((taskId: string | undefined, commandOptions: { summary?: boolean }) => {
    if (taskId === undefined) {
      console.error("Task id is required.");
      process.exitCode = 1;
      return;
    }

    const handle = createApplication(process.cwd());
    try {
      const trace = handle.service.traceTask(taskId);
      console.log(commandOptions.summary ? summarizeTrace(trace) : formatTrace(trace));
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

  program
    .command("audit")
    .argument("<task_id>", "Task identifier")
    .option("--summary", "Print summary instead of raw entries")
    .action((taskId: string, commandOptions: { summary?: boolean }) => {
      const handle = createApplication(process.cwd());
      try {
        const audit = handle.service.auditTask(taskId);
        console.log(commandOptions.summary ? summarizeAudit(audit) : formatAuditLog(audit));
      } finally {
        handle.close();
      }
    });

  const inboxCommand = program.command("inbox").description("Inspect collaboration inbox items");
  inboxCommand
    .option("--user <user>", "Filter by runtime user id")
    .option("--status <status>", "Filter status: pending | seen | done | dismissed", "pending")
    .option(
      "--category <category>",
      "Filter category: task_completed | task_failed | task_blocked | decision_requested | approval_requested | memory_suggestion | skill_promotion"
    )
    .option("--limit <count>", "Limit entries", "50")
    .action((commandOptions: {
      category?:
        | "task_completed"
        | "task_failed"
        | "task_blocked"
        | "decision_requested"
        | "approval_requested"
        | "memory_suggestion"
        | "skill_promotion";
      limit?: string;
      status?: "pending" | "seen" | "done" | "dismissed";
      user?: string;
    }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(
          formatInboxList(
            handle.service.listInbox({
              ...(commandOptions.user !== undefined ? { userId: commandOptions.user } : {}),
              ...(commandOptions.status !== undefined ? { status: commandOptions.status } : {}),
              ...(commandOptions.category !== undefined ? { category: commandOptions.category } : {}),
              ...(commandOptions.limit !== undefined
                ? { limit: Number.parseInt(commandOptions.limit, 10) }
                : {})
            })
          )
        );
      } finally {
        handle.close();
      }
    });
  inboxCommand
    .command("list")
    .option("--user <user>", "Filter by runtime user id")
    .option("--status <status>", "Filter status: pending | seen | done | dismissed", "pending")
    .option(
      "--category <category>",
      "Filter category: task_completed | task_failed | task_blocked | decision_requested | approval_requested | memory_suggestion | skill_promotion"
    )
    .option("--limit <count>", "Limit entries", "50")
    .action((commandOptions: {
      category?:
        | "task_completed"
        | "task_failed"
        | "task_blocked"
        | "decision_requested"
        | "approval_requested"
        | "memory_suggestion"
        | "skill_promotion";
      limit?: string;
      status?: "pending" | "seen" | "done" | "dismissed";
      user?: string;
    }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(
          formatInboxList(
            handle.service.listInbox({
              ...(commandOptions.user !== undefined ? { userId: commandOptions.user } : {}),
              ...(commandOptions.status !== undefined ? { status: commandOptions.status } : {}),
              ...(commandOptions.category !== undefined ? { category: commandOptions.category } : {}),
              ...(commandOptions.limit !== undefined
                ? { limit: Number.parseInt(commandOptions.limit, 10) }
                : {})
            })
          )
        );
      } finally {
        handle.close();
      }
    });
  inboxCommand.command("show").argument("<inbox_id>").action((inboxId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const item = handle.service.showInboxItem(inboxId);
      if (item === null) {
        console.error(`Inbox item ${inboxId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(formatInboxDetail(item));
    } finally {
      handle.close();
    }
  });
  inboxCommand.command("done").argument("<inbox_id>").action((inboxId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const reviewer = process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
      console.log(formatInboxDetail(handle.service.markInboxDone(inboxId, reviewer)));
    } finally {
      handle.close();
    }
  });
  inboxCommand.command("dismiss").argument("<inbox_id>").action((inboxId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatInboxDetail(handle.service.markInboxDismissed(inboxId)));
    } finally {
      handle.close();
    }
  });

  const commitmentsCommand = program.command("commitments").description("Manage thread commitments");
  commitmentsCommand
    .command("list")
    .option("--thread <thread_id>", "Thread id")
    .option("--status <status>", "Filter status")
    .action((commandOptions: { thread?: string; status?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const list = handle.service.listCommitments({
          ...(commandOptions.thread !== undefined ? { threadId: commandOptions.thread } : {}),
          ...(commandOptions.status !== undefined ? { status: commandOptions.status as CommitmentRecord["status"] } : {})
        });
        console.log(formatCommitmentList(list));
      } finally {
        handle.close();
      }
    });
  commitmentsCommand.command("show").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const item = handle.service.showCommitment(commitmentId);
      if (item === null) {
        console.error(`Commitment ${commitmentId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(formatCommitmentDetail(item));
    } finally {
      handle.close();
    }
  });
  commitmentsCommand
    .command("create")
    .requiredOption("--thread <thread_id>", "Thread id")
    .requiredOption("--title <title>", "Commitment title")
    .option("--summary <summary>", "Commitment summary", "")
    .action((commandOptions: { thread: string; title: string; summary?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const ownerUserId = process.env.USERNAME ?? process.env.USER ?? "local-user";
        const created = handle.service.createCommitment({
          ownerUserId,
          source: "manual",
          summary: commandOptions.summary ?? "",
          threadId: commandOptions.thread,
          title: commandOptions.title
        });
        console.log(formatCommitmentDetail(created));
      } finally {
        handle.close();
      }
    });
  commitmentsCommand
    .command("block")
    .argument("<commitment_id>")
    .requiredOption("--reason <reason>")
    .action((commitmentId: string, commandOptions: { reason: string }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatCommitmentDetail(handle.service.blockCommitment(commitmentId, commandOptions.reason)));
      } finally {
        handle.close();
      }
    });
  commitmentsCommand.command("unblock").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCommitmentDetail(handle.service.unblockCommitment(commitmentId)));
    } finally {
      handle.close();
    }
  });
  commitmentsCommand.command("complete").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCommitmentDetail(handle.service.completeCommitment(commitmentId)));
    } finally {
      handle.close();
    }
  });
  commitmentsCommand.command("cancel").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCommitmentDetail(handle.service.cancelCommitment(commitmentId)));
    } finally {
      handle.close();
    }
  });

  const nextCommand = program.command("next").description("Manage next actions");
  nextCommand
    .command("list")
    .option("--thread <thread_id>", "Thread id")
    .action((commandOptions: { thread?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const list = handle.service.listNextActions(
          commandOptions.thread !== undefined ? { threadId: commandOptions.thread } : {}
        );
        console.log(formatNextActionList(list));
      } finally {
        handle.close();
      }
    });
  nextCommand
    .command("add")
    .requiredOption("--thread <thread_id>", "Thread id")
    .requiredOption("--title <title>", "Action title")
    .option("--commitment <commitment_id>", "Related commitment id")
    .action((commandOptions: { thread: string; title: string; commitment?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const created = handle.service.appendNextAction({
          commitmentId: commandOptions.commitment ?? null,
          source: "manual",
          status: "pending",
          threadId: commandOptions.thread,
          title: commandOptions.title
        });
        console.log(formatNextActionList([created]));
      } finally {
        handle.close();
      }
    });
  nextCommand.command("done").argument("<next_action_id>").action((nextActionId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatNextActionList([handle.service.markNextActionDone(nextActionId)]));
    } finally {
      handle.close();
    }
  });
  nextCommand
    .command("block")
    .argument("<next_action_id>")
    .requiredOption("--reason <reason>")
    .action((nextActionId: string, commandOptions: { reason: string }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatNextActionList([handle.service.blockNextAction(nextActionId, commandOptions.reason)]));
      } finally {
        handle.close();
      }
    });
  nextCommand.command("unblock").argument("<next_action_id>").action((nextActionId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatNextActionList([handle.service.unblockNextAction(nextActionId)]));
    } finally {
      handle.close();
    }
  });
  nextCommand
    .command("resume")
    .option("--cwd <path>", "Working directory", process.cwd())
    .action(async (commandOptions: { cwd: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const result = await handle.service.continueLatest(undefined, { cwd: commandOptions.cwd });
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Thread ID: ${result.task.threadId ?? "-"}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
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
        if (result.error !== undefined) {
          console.log(`Error: ${result.error.code} ${result.error.message}`);
        }
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
    .command("doctor")
    .description("Run configuration and environment checks")
    .action(async () => {
      const handle = createApplication(process.cwd());
      try {
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

  skillsCommand.command("promote").argument("<draft_id>", "Skill draft identifier").action((draftId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillDraft(handle.service.promoteSkillDraft(draftId)));
    } finally {
      handle.close();
    }
  });

  const workspaceCommand = program.command("workspace").description("Inspect workspace coding context");

  workspaceCommand
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
    .command("repo")
    .description("Deprecated alias for workspace")
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

  workspaceCommand
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

  providerCommand.command("list").option("--json", "Print JSON").action((commandOptions: { json?: boolean }) => {
    const handle = createApplication(process.cwd());
    try {
      const providers = handle.service.listProviders();
      console.log(commandOptions.json === true
        ? JSON.stringify(providers, null, 2)
        : formatProviderCatalog(handle.service.currentProvider().name, providers));
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
    .option("--dry-run", "Show replay parameters without executing")
    .action(
      async (
        taskId: string,
        commandOptions: {
          cwd: string;
          dryRun?: boolean;
          fromIteration: string;
          provider: "current" | "mock";
        }
      ) => {
        if (commandOptions.dryRun === true) {
          console.log(
            `Replay dry-run: task=${taskId} cwd=${commandOptions.cwd} fromIteration=${commandOptions.fromIteration} provider=${commandOptions.provider}`
          );
          return;
        }
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
    .option("--explain", "Append plain-language explanation")
    .option("--output <path>", "Write the report to a file")
    .action(
      async (commandOptions: {
        fixture?: string;
        explain?: boolean;
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
        let output = commandOptions.json === true
          ? JSON.stringify(report, null, 2)
          : formatEvalReport(report);
        if (commandOptions.explain === true && commandOptions.json !== true) {
          output = `${output}\nExplanation: The suite validates repeatable core workflows and flags provider/policy regressions.`;
        }
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
    .command("smoke")
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

  const releaseCommand = program.command("release").description("Release readiness checks");
  releaseCommand
    .command("check")
    .option("--provider <provider>", "Provider to use for eval checks", "scripted-smoke")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (commandOptions: { cwd: string; provider: SupportedProviderName | "scripted-smoke" }) => {
      const report = await runReleaseChecklist({
        cwd: commandOptions.cwd,
        provider: commandOptions.provider
      });
      console.log(formatReleaseChecklistReport(report));
      if (!report.allPassed) {
        process.exitCode = 1;
      }
    });

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
    .option("--mode <mode>", "UI mode: chat | dashboard", "chat")
    .option("--resume <sessionId>", "Resume a saved session from .auto-talon/sessions")
    .action(async (commandOptions: SandboxCommandOptions & { mode?: string; resume?: string }) => {
      if (commandOptions.mode === "dashboard") {
        await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
        return;
      }
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

  const gatewayCommand = program
    .command("gateway")
    .description("Run minimal external gateway adapters");

  gatewayCommand
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

  gatewayCommand
    .command("serve-feishu")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--local-webhook-port <port>", "Also start local webhook on this port")
    .action(async (commandOptions: SandboxCommandOptions & { localWebhookPort?: string }) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      const feishu = await startFeishuGateway(handle);
      const extraManagers: GatewayManager[] = [feishu.manager];
      if (commandOptions.localWebhookPort !== undefined) {
        const local = await startLocalWebhookGateway(handle, {
          host: "127.0.0.1",
          port: Number(commandOptions.localWebhookPort)
        });
        extraManagers.push(local.manager);
      }

      console.log(`Feishu adapter ${feishu.adapter.descriptor.adapterId} is running.`);
      const shutdown = async (): Promise<void> => {
        for (const manager of extraManagers) {
          await manager.stopAll();
        }
        handle.close();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });

  gatewayCommand
    .command("list-adapters")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action((commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const listedAdapters: InboundMessageAdapter[] = [
          new LocalWebhookAdapter({ port: 0, adapterId: "local-webhook" })
        ];
        try {
          listedAdapters.push(createFeishuGatewayPlugin().createAdapter(handle));
        } catch {
          // Optional adapter: only listed when config is present.
        }
        const manager = new GatewayManager(createGatewayRuntime(handle), listedAdapters);
        for (const adapter of manager.listAdapters()) {
          console.log(
            `${adapter.descriptor.adapterId} (${adapter.descriptor.kind}) ${JSON.stringify(adapter.descriptor.capabilities)}`
          );
        }
      } finally {
        handle.close();
      }
    });

  await program.parseAsync(argv);
}

interface SandboxCommandOptions {
  cwd: string;
  sandboxMode?: string;
  sandboxProfile?: string;
  writeRoot?: string[];
}

interface RunCommandOptions extends SandboxCommandOptions {
  maxIterations?: string;
  profile: string;
  thread?: string;
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

#!/usr/bin/env node
import { Command } from "commander";

import { createApplication, createDefaultRunOptions } from "../runtime";

import {
  formatApprovalList,
  formatAuditLog,
  formatDoctorReport,
  formatMemoryList,
  formatMemoryScope,
  formatSnapshot,
  formatTask,
  formatTaskList,
  formatTrace
} from "./formatters";

async function main(): Promise<void> {
  const program = new Command();
  program.name("agent").description("Agent Runtime MVP CLI").version("0.1.0");

  program
    .command("run")
    .argument("<task>", "Task prompt to execute")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--profile <profile>", "Agent profile", "executor")
    .option("--max-iterations <number>", "Maximum loop iterations")
    .option("--timeout-ms <number>", "Task timeout in milliseconds")
    .action(async (task: string, commandOptions: { cwd: string; profile: string; maxIterations?: string; timeoutMs?: string }) => {
      const handle = createApplication(commandOptions.cwd);
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
        if (result.error !== undefined) {
          console.error(`Error: ${result.error.code} ${result.error.message}`);
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

  program.command("trace").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTrace(handle.service.traceTask(taskId)));
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

  program.command("config").description("Configuration and environment checks").command("doctor").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatDoctorReport(handle.service.configDoctor()));
    } finally {
      handle.close();
    }
  });

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

  await program.parseAsync(process.argv);
}

void main();

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

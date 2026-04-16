#!/usr/bin/env node
import { Command } from "commander";

import { createApplication, createDefaultRunOptions } from "../runtime";

import {
  formatDoctorReport,
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
    .option("--max-iterations <number>", "Maximum loop iterations")
    .option("--timeout-ms <number>", "Task timeout in milliseconds")
    .action(async (task: string, commandOptions: { cwd: string; maxIterations?: string; timeoutMs?: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const runOptions = createDefaultRunOptions(task, commandOptions.cwd, handle.config);
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

      console.log(formatTask(result.task, result.toolCalls));
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

  program.command("config").description("Configuration and environment checks").command("doctor").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatDoctorReport(handle.service.configDoctor()));
    } finally {
      handle.close();
    }
  });

  await program.parseAsync(process.argv);
}

void main();

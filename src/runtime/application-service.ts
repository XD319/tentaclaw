import type { Provider, RuntimeRunOptions, TaskRecord, TraceEvent, ToolCallRecord } from "../types";
import type { ExecutionKernel } from "./execution-kernel";

import { AppError } from "./app-error";
 
export interface RunTaskResult {
  error?: AppError;
  output: string | null;
  task: TaskRecord;
}

export interface AgentDoctorReport {
  databasePath: string;
  nodeVersion: string;
  providerName: string;
  runtimeVersion: string;
  shell: string | undefined;
  workspaceRoot: string;
}

export interface RuntimeReadModel {
  findTask(taskId: string): TaskRecord | null;
  listTasks(): TaskRecord[];
  listToolCalls(taskId: string): ToolCallRecord[];
  listTrace(taskId: string): TraceEvent[];
}

export interface AgentApplicationServiceDependencies extends RuntimeReadModel {
  databasePath: string;
  executionKernel: ExecutionKernel;
  provider: Provider;
  runtimeVersion: string;
  workspaceRoot: string;
}

export class AgentApplicationService {
  public constructor(private readonly dependencies: AgentApplicationServiceDependencies) {}

  public async runTask(options: RuntimeRunOptions): Promise<RunTaskResult> {
    try {
      const result = await this.dependencies.executionKernel.run(options);
      return {
        output: result.output,
        task: result.task
      };
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError({
              code: "provider_error",
              message: error instanceof Error ? error.message : "Unknown runtime error"
            });

      const taskId =
        typeof appError.details?.taskId === "string" ? appError.details.taskId : null;
      const task = taskId === null ? null : this.dependencies.findTask(taskId);
      if (task === null) {
        throw appError;
      }

      return {
        error: appError,
        output: null,
        task
      };
    }
  }

  public listTasks(): TaskRecord[] {
    return this.dependencies.listTasks();
  }

  public showTask(taskId: string): {
    task: TaskRecord | null;
    toolCalls: ToolCallRecord[];
    trace: TraceEvent[];
  } {
    const task = this.dependencies.findTask(taskId);

    return {
      task,
      toolCalls: task === null ? [] : this.dependencies.listToolCalls(taskId),
      trace: task === null ? [] : this.dependencies.listTrace(taskId)
    };
  }

  public traceTask(taskId: string): TraceEvent[] {
    return this.dependencies.listTrace(taskId);
  }

  public configDoctor(): AgentDoctorReport {
    return {
      databasePath: this.dependencies.databasePath,
      nodeVersion: process.version,
      providerName: this.dependencies.provider.name,
      runtimeVersion: this.dependencies.runtimeVersion,
      shell: process.env.ComSpec,
      workspaceRoot: this.dependencies.workspaceRoot
    };
  }
}

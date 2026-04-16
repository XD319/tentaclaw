import { randomUUID } from "node:crypto";

import { createManagedAbortController, throwIfAborted } from "./abort-controller";
import { AppError, toAppError } from "./app-error";
import { ExecutionContextAssembler } from "./context-assembler";
import { tokenBudgetToJson } from "./serialization";
import type {
  ConversationMessage,
  Provider,
  RunMetadataRepository,
  RuntimeRunOptions,
  RuntimeRunResult,
  TaskRepository
} from "../types";
import type { MemoryPlane } from "../memory/memory-plane";
import type { ToolOrchestrator } from "../tools";
import type { TraceService } from "../tracing/trace-service";

export interface ExecutionKernelDependencies {
  memoryPlane: MemoryPlane;
  provider: Provider;
  runMetadataRepository: RunMetadataRepository;
  runtimeVersion: string;
  taskRepository: TaskRepository;
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  workspaceRoot: string;
}

export class ExecutionKernel {
  private readonly contextAssembler = new ExecutionContextAssembler();

  public constructor(private readonly dependencies: ExecutionKernelDependencies) {}

  public async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    const taskId = randomUUID();
    let task = this.dependencies.taskRepository.create({
      cwd: options.cwd,
      input: options.taskInput,
      maxIterations: options.maxIterations,
      metadata: options.metadata ?? {},
      providerName: this.dependencies.provider.name,
      taskId,
      tokenBudget: options.tokenBudget
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "task_created",
      payload: {
        cwd: options.cwd,
        input: options.taskInput,
        providerName: this.dependencies.provider.name
      },
      stage: "lifecycle",
      summary: "Task persisted",
      taskId
    });

    this.dependencies.runMetadataRepository.create({
      createdAt: new Date().toISOString(),
      metadata: options.metadata ?? {},
      providerName: this.dependencies.provider.name,
      runMetadataId: randomUUID(),
      runtimeVersion: this.dependencies.runtimeVersion,
      taskId,
      timeoutMs: options.timeoutMs,
      tokenBudget: options.tokenBudget,
      workspaceRoot: this.dependencies.workspaceRoot
    });

    const managedAbortController = createManagedAbortController(
      options.timeoutMs,
      options.signal
    );

    try {
      task = this.dependencies.taskRepository.update(taskId, {
        startedAt: new Date().toISOString(),
        status: "running"
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "task_started",
        payload: {
          maxIterations: options.maxIterations,
          timeoutMs: options.timeoutMs
        },
        stage: "lifecycle",
        summary: "Task execution started",
        taskId
      });

      const memoryContext = await this.dependencies.memoryPlane.buildContext(task);
      const availableTools = this.dependencies.toolOrchestrator.listTools();
      const messages = this.contextAssembler.buildInitialMessages(task, availableTools);

      for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
        throwIfAborted(managedAbortController.abortController.signal, managedAbortController.getReason());

        task = this.dependencies.taskRepository.update(taskId, {
          currentIteration: iteration
        });

        const providerInput = this.contextAssembler.assemble({
          availableTools,
          iteration,
          memoryContext,
          messages,
          signal: managedAbortController.abortController.signal,
          task,
          tokenBudget: options.tokenBudget
        });

        this.dependencies.traceService.record({
          actor: `provider.${this.dependencies.provider.name}`,
          eventType: "model_request",
          payload: {
            availableTools: availableTools.map((tool) => tool.name),
            inputMessageCount: messages.length,
            iteration,
            tokenBudget: tokenBudgetToJson(options.tokenBudget)
          },
          stage: "planning",
          summary: "Provider request assembled",
          taskId
        });

        const providerResponse = await this.dependencies.provider.generate(providerInput);
        messages.push({
          content: providerResponse.message,
          role: "assistant"
        });

        this.dependencies.traceService.record({
          actor: `provider.${this.dependencies.provider.name}`,
          eventType: "model_response",
          payload: {
            iteration,
            kind: providerResponse.kind,
            message: providerResponse.message,
            toolNames:
              providerResponse.kind === "tool_calls"
                ? providerResponse.toolCalls.map((call) => call.toolName)
                : []
          },
          stage: "planning",
          summary: `Provider responded with ${providerResponse.kind}`,
          taskId
        });

        if (providerResponse.kind === "retry") {
          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "retry",
            payload: {
              delayMs: providerResponse.delayMs,
              iteration,
              reason: providerResponse.reason
            },
            stage: "control",
            summary: "Retry requested by provider",
            taskId
          });

          await sleepWithAbort(
            providerResponse.delayMs,
            managedAbortController.abortController.signal
          );

          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "loop_iteration_completed",
            payload: {
              iteration,
              toolCallCount: 0
            },
            stage: "control",
            summary: "Loop iteration completed after retry",
            taskId
          });
          continue;
        }

        if (providerResponse.kind === "final") {
          task = this.dependencies.taskRepository.update(taskId, {
            finalOutput: providerResponse.message,
            finishedAt: new Date().toISOString(),
            status: "succeeded"
          });

          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "final_outcome",
            payload: {
              errorCode: null,
              errorMessage: null,
              output: providerResponse.message,
              status: "succeeded"
            },
            stage: "completion",
            summary: "Task completed successfully",
            taskId
          });

          return {
            output: providerResponse.message,
            task
          };
        }

        task = this.dependencies.taskRepository.update(taskId, {
          status: "waiting_tool"
        });

        let toolCallCount = 0;
        for (const toolCall of providerResponse.toolCalls) {
          throwIfAborted(
            managedAbortController.abortController.signal,
            managedAbortController.getReason()
          );

          const outcome = await this.dependencies.toolOrchestrator.execute(
            {
              input: toolCall.input,
              iteration,
              reason: toolCall.reason,
              taskId,
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName
            },
            {
              cwd: options.cwd,
              iteration,
              signal: managedAbortController.abortController.signal,
              taskId,
              workspaceRoot: this.dependencies.workspaceRoot
            }
          );

          toolCallCount += 1;
          messages.push(createToolFeedbackMessage(outcome.result.output, toolCall));
        }

        task = this.dependencies.taskRepository.update(taskId, {
          status: "running"
        });

        this.dependencies.traceService.record({
          actor: "runtime.kernel",
          eventType: "loop_iteration_completed",
          payload: {
            iteration,
            toolCallCount
          },
          stage: "control",
          summary: "Loop iteration completed after tool execution",
          taskId
        });
      }

      throw new AppError({
        code: "max_rounds_exceeded",
        message: `Task exceeded ${options.maxIterations} iterations.`
      });
    } catch (error) {
      const appError = toAppError(error);
      const isCancelled = appError.code === "interrupt";

      if (appError.code === "interrupt" || appError.code === "timeout") {
        this.dependencies.traceService.record({
          actor: "runtime.kernel",
          eventType: "interrupt",
          payload: {
            iteration: task.currentIteration,
            reason: appError.message
          },
          stage: "control",
          summary: `Task interrupted with ${appError.code}`,
          taskId
        });
      }

      task = this.dependencies.taskRepository.update(taskId, {
        errorCode: appError.code,
        errorMessage: appError.message,
        finishedAt: new Date().toISOString(),
        status: isCancelled ? "cancelled" : "failed"
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "final_outcome",
        payload: {
          errorCode: appError.code,
          errorMessage: appError.message,
          output: null,
          status: isCancelled ? "cancelled" : "failed"
        },
        stage: "completion",
        summary: "Task finished with an error",
        taskId
      });

      throw new AppError({
        cause: appError,
        code: appError.code,
        details: {
          ...(appError.details ?? {}),
          taskId
        },
        message: appError.message
      });
    } finally {
      managedAbortController.dispose();
    }
  }
}

function createToolFeedbackMessage(
  output: unknown,
  toolCall: { toolCallId: string; toolName: string }
): ConversationMessage {
  return {
    content: JSON.stringify(output, null, 2),
    role: "tool",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName
  };
}

async function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(
        new AppError({
          code: "interrupt",
          message: "Retry wait interrupted."
        })
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

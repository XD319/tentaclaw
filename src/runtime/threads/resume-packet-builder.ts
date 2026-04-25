import type { AppConfig } from "../bootstrap.js";
import type { JsonObject, RuntimeRunOptions } from "../../types/index.js";
import type { ThreadStateProjector } from "./thread-state-projector.js";

export interface ResumePacketBuilderDependencies {
  stateProjector: ThreadStateProjector;
  config: AppConfig;
}

export class ResumePacketBuilder {
  public constructor(private readonly dependencies: ResumePacketBuilderDependencies) {}

  public buildResumePacket(
    threadId: string,
    newInput: string,
    overrides?: Partial<RuntimeRunOptions>
  ): RuntimeRunOptions & { threadId: string } {
    const projection = this.dependencies.stateProjector.projectState(threadId);
    const metadata: JsonObject = {
      ...(overrides?.metadata ?? {}),
      threadResume: {
        blockedReason: projection.commitmentState.blockedReason,
        commitments: projection.commitmentState.openCommitments,
        contextMessages: projection.messages,
        focusState: projection.focusState,
        memoryContext: projection.memoryContext,
        nextAction: projection.commitmentState.nextAction,
        pendingDecision: projection.commitmentState.pendingDecision,
        projectedMessageCount: projection.messages.length
      } as unknown as JsonObject
    };
    return {
      agentProfileId: overrides?.agentProfileId ?? this.dependencies.config.defaultProfileId,
      cwd: overrides?.cwd ?? this.dependencies.config.workspaceRoot,
      maxIterations: overrides?.maxIterations ?? this.dependencies.config.defaultMaxIterations,
      metadata,
      taskInput: newInput,
      threadId,
      timeoutMs: overrides?.timeoutMs ?? this.dependencies.config.defaultTimeoutMs,
      tokenBudget: overrides?.tokenBudget ?? this.dependencies.config.tokenBudget,
      userId:
        overrides?.userId ?? process.env.USERNAME ?? process.env.USER ?? "local-user"
    };
  }
}

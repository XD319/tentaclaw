import type { AgentApplicationService, RunTaskResult } from "../runtime/application-service.js";
import type { RuntimeRunOptions, TuiInteractionMode } from "../types/index.js";

export interface ActiveTurn {
  abort: AbortController;
  done: Promise<RunTaskResult>;
  sessionId: string;
  taskId: string;
}

export class SessionTurnManager {
  private readonly turns = new Map<string, ActiveTurn>();

  public start(
    service: AgentApplicationService,
    sessionId: string,
    input: string,
    overrides: Partial<RuntimeRunOptions> = {}
  ): ActiveTurn {
    const abort = new AbortController();
    const started = service.startSessionTurn(sessionId, input, {
      ...overrides,
      signal: abort.signal
    });
    const turn: ActiveTurn = {
      abort,
      done: started.done.finally(() => {
        this.turns.delete(started.taskId);
      }),
      sessionId,
      taskId: started.taskId
    };
    this.turns.set(started.taskId, turn);
    return turn;
  }

  public stop(taskId: string): boolean {
    const turn = this.turns.get(taskId);
    if (turn === undefined) {
      return false;
    }
    turn.abort.abort();
    return true;
  }

  public get(taskId: string): ActiveTurn | undefined {
    return this.turns.get(taskId);
  }
}

export function parseInteractionMode(value: unknown): TuiInteractionMode | undefined {
  if (value === "agent" || value === "plan" || value === "acceptEdits") {
    return value;
  }
  return undefined;
}

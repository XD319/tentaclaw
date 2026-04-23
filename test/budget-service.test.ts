import { describe, expect, it, vi } from "vitest";

import { BudgetService } from "../src/runtime/budget/budget-service.js";

describe("budget service", () => {
  it("emits soft then hard decisions", () => {
    const traceService = { record: vi.fn() } as never;
    const auditService = { record: vi.fn() } as never;
    const service = new BudgetService(
      {
        task: { hardCostUsd: 2, softCostUsd: 1 },
        thread: {}
      },
      traceService,
      auditService
    );

    const soft = service.recordUsage({
      costUsd: 1.2,
      mode: "balanced",
      taskId: "task-1",
      threadId: null,
      usage: { inputTokens: 10, outputTokens: 5 }
    });
    const hard = service.recordUsage({
      costUsd: 1,
      mode: "balanced",
      taskId: "task-1",
      threadId: null,
      usage: { inputTokens: 10, outputTokens: 5 }
    });

    expect(soft.status).toBe("soft");
    expect(hard.status).toBe("hard");
    expect(service.isDowngradeActive("task", "task-1")).toBe(true);
  });
});

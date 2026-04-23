import { describe, expect, it, vi } from "vitest";

import { ProviderRouter } from "../src/providers/routing/provider-router.js";

describe("provider router", () => {
  it("selects tier by mode", () => {
    const router = new ProviderRouter(
      {
        helpers: { classify: null, recallRank: null, summarize: "cheap" },
        mode: "quality_first",
        providers: { balanced: "mock", cheap: "mock", quality: "mock" }
      },
      () => ({ generate: vi.fn(), name: "mock" }),
      { isDowngradeActive: () => false } as never,
      { record: vi.fn() } as never,
      { record: vi.fn() } as never
    );

    const selected = router.selectProvider({ kind: "main", taskId: "t1", threadId: null });
    expect(selected.tier).toBe("quality");
  });
});

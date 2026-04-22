import { describe, expect, it } from "vitest";

import { GatewayGuard } from "../src/gateway";

describe("gateway guard", () => {
  it("rate limits repeated requests", async () => {
    const guard = new GatewayGuard({
      cwd: process.cwd(),
      now: (() => {
        let current = 0;
        return () => current++;
      })()
    });

    const request = {
      requester: {
        externalSessionId: "s1",
        externalUserId: "u1",
        externalUserLabel: null
      },
      taskInput: "hello"
    };

    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => guard.evaluate("test", request))
    );
    expect(decisions.some((decision) => !decision.allowed && decision.reason === "rate_limited")).toBe(true);
  });

  it("denies identities from env denylist", async () => {
    process.env.AGENT_GATEWAY_DENYLIST = "test:u2";
    const guard = new GatewayGuard({
      cwd: process.cwd()
    });
    const decision = await guard.evaluate("test", {
      requester: {
        externalSessionId: "s2",
        externalUserId: "u2",
        externalUserLabel: null
      },
      taskInput: "blocked"
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("denied");
    }
    delete process.env.AGENT_GATEWAY_DENYLIST;
  });
});

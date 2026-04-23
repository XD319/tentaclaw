import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startLocalWebhookGateway } from "../gateway/index.js";
import { resolveFeishuGatewayConfig } from "../gateway/feishu/feishu-config.js";
import { ProviderError } from "../providers/index.js";
import { createApplication, createDefaultRunOptions } from "../runtime/index.js";
import type { SupportedProviderName } from "../providers/index.js";
import { runEvalReport } from "./eval.js";
import type { Provider, ProviderInput, ProviderResponse } from "../types/index.js";

export interface BetaChecklistItem {
  details: string;
  id: string;
  ok: boolean;
  title: string;
}

export interface BetaReadinessReport {
  allPassed: boolean;
  checklist: BetaChecklistItem[];
  generatedAt: string;
}

export interface BetaReadinessOptions {
  minimumSuccessRate?: number;
  providerName?: SupportedProviderName | "scripted-smoke";
}

export async function runBetaReadinessCheck(
  options: BetaReadinessOptions = {}
): Promise<BetaReadinessReport> {
  const minimumSuccessRate = options.minimumSuccessRate ?? 0.8;
  const evalReport = await runEvalReport({
    providerName: options.providerName ?? "scripted-smoke"
  });
  const denyPath = await verifyApprovalDenyPath();
  const providerDiagnostics = await verifyProviderFailureDiagnostics();
  const gatewayPath = await verifyGatewayAdapterPath();
  const feishuConfig = verifyOptionalFeishuConfig();

  const checklist: BetaChecklistItem[] = [
    {
      details: `successRate=${(evalReport.successRate * 100).toFixed(1)}% threshold=${(minimumSuccessRate * 100).toFixed(1)}%`,
      id: "real-task-success-rate",
      ok: evalReport.successRate >= minimumSuccessRate,
      title: "Real task sample success rate reaches threshold"
    },
    {
      details: `approval/audit coverage check=${denyPath.approvalAuditComplete ? "complete" : "incomplete"}`,
      id: "high-risk-trace-audit",
      ok: denyPath.approvalAuditComplete,
      title: "High-risk trace and audit stay complete"
    },
    {
      details: `restricted memory selected during recall=${denyPath.restrictedMemoryLeakDetected ? "yes" : "no"}`,
      id: "memory-recall-leak",
      ok: !denyPath.restrictedMemoryLeakDetected,
      title: "Memory recall does not leak restricted data"
    },
    {
      details: `deny path task status=${denyPath.status} error=${denyPath.errorCode ?? "-"}`,
      id: "approval-deny-stable",
      ok: denyPath.ok,
      title: "Approval allow/deny path remains stable"
    },
    {
      details: `provider error trace visible=${providerDiagnostics.traceVisible ? "yes" : "no"} category=${providerDiagnostics.category ?? "-"}`,
      id: "provider-errors-diagnosable",
      ok: providerDiagnostics.ok,
      title: "Provider errors stay diagnosable"
    },
    {
      details: `webhook adapter status=${gatewayPath.status} output=${gatewayPath.output ?? "-"}`,
      id: "external-adapter-path",
      ok: gatewayPath.ok,
      title: "At least one external adapter path remains available"
    },
    {
      details: feishuConfig.details,
      id: "feishu-config-shape",
      ok: feishuConfig.ok,
      title: "Feishu config is valid when present"
    }
  ];

  return {
    allPassed: checklist.every((item) => item.ok),
    checklist,
    generatedAt: new Date().toISOString()
  };
}

function verifyOptionalFeishuConfig(): { details: string; ok: boolean } {
  try {
    resolveFeishuGatewayConfig(process.cwd());
    return {
      details: "feishu config found and parsed",
      ok: true
    };
  } catch {
    return {
      details: "feishu config missing or invalid; adapter remains optional",
      ok: true
    };
  }
}

class ScriptedProvider implements Provider {
  public readonly name = "beta-scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse,
    public readonly model = "beta-scripted-model"
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

async function verifyApprovalDenyPath(): Promise<{
  approvalAuditComplete: boolean;
  errorCode: string | null;
  ok: boolean;
  restrictedMemoryLeakDetected: boolean;
  status: string;
}> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-beta-deny-"));
  const databasePath = join(workspaceRoot, "runtime.db");
  await fs.writeFile(join(workspaceRoot, "README.md"), "beta deny path", "utf8");

  const handle = createApplication(workspaceRoot, {
    config: {
      databasePath
    },
    provider: new ScriptedProvider((input) => {
      const toolMessages = input.messages.filter((message) => message.role === "tool");
      if (toolMessages.length > 0) {
        return {
          kind: "final",
          message: "unexpected follow-up after denial",
          usage: {
            inputTokens: 4,
            outputTokens: 2
          }
        };
      }

      return {
        kind: "tool_calls",
        message: "run governed shell command",
        toolCalls: [
          {
            input: {
              command: "whoami"
            },
            reason: "run governed shell command",
            toolCallId: "beta-governed-shell",
            toolName: "shell"
          }
        ],
        usage: {
          inputTokens: 8,
          outputTokens: 3
        }
      };
    })
  });

  try {
    const runOptions = createDefaultRunOptions("run governed shell command", workspaceRoot, handle.config);
    const initial = await handle.service.runTask(runOptions);
    const approval = handle.service.listPendingApprovals()[0];
    if (approval === undefined) {
      return {
        approvalAuditComplete: false,
        errorCode: initial.task.errorCode,
        ok: false,
        restrictedMemoryLeakDetected: false,
        status: initial.task.status
      };
    }

    const denied = await handle.service.resolveApproval(approval.approvalId, "deny", "beta-check");
    const trace = handle.service.traceTask(denied.task.taskId);
    const audit = handle.service.auditTask(denied.task.taskId);
    const recallEvents = trace.filter(
      (event): event is Extract<typeof event, { eventType: "memory_recalled" }> =>
        event.eventType === "memory_recalled"
    );

    return {
      approvalAuditComplete:
        trace.some((event) => event.eventType === "approval_requested") &&
        trace.some(
          (event) =>
            event.eventType === "approval_resolved" && event.payload.status === "denied"
        ) &&
        audit.some(
          (entry) =>
            entry.action === "approval_resolved" && entry.outcome === "denied"
        ),
      errorCode: denied.task.errorCode,
      ok: denied.task.status === "failed" && denied.task.errorCode === "approval_denied",
      restrictedMemoryLeakDetected: recallEvents.some((event) =>
        event.payload.entries.some(
          (entry) => entry.privacyLevel === "restricted" && entry.selected
        )
      ),
      status: denied.task.status
    };
  } finally {
    handle.close();
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function verifyProviderFailureDiagnostics(): Promise<{
  category: string | null;
  ok: boolean;
  traceVisible: boolean;
}> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-beta-provider-"));
  const handle = createApplication(workspaceRoot, {
    config: {
      databasePath: join(workspaceRoot, "runtime.db")
    },
    provider: new ScriptedProvider(() => {
      throw new ProviderError({
        category: "rate_limit",
        message: "beta provider throttled",
        modelName: "beta-scripted-model",
        providerName: "beta-scripted-provider",
        retriable: true,
        summary: "beta provider throttled"
      });
    })
  });

  try {
    const result = await handle.service.runTask(
      createDefaultRunOptions("trigger provider failure", workspaceRoot, handle.config)
    );
    const trace = handle.service.traceTask(result.task.taskId);
    const failureTrace = trace.find((event) => event.eventType === "provider_request_failed");

    return {
      category:
        failureTrace?.eventType === "provider_request_failed"
          ? failureTrace.payload.errorCategory
          : null,
      ok:
        result.error?.details?.providerCategory === "rate_limit" &&
        failureTrace?.eventType === "provider_request_failed" &&
        failureTrace.payload.errorCategory === "rate_limit",
      traceVisible: failureTrace !== undefined
    };
  } finally {
    handle.close();
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function verifyGatewayAdapterPath(): Promise<{
  ok: boolean;
  output: string | null;
  status: string;
}> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-beta-gateway-"));
  const handle = createApplication(workspaceRoot, {
    config: {
      databasePath: join(workspaceRoot, "runtime.db")
    },
    provider: new ScriptedProvider(() => ({
      kind: "final",
      message: "gateway beta ready",
      usage: {
        inputTokens: 6,
        outputTokens: 3
      }
    }))
  });

  const port = await getFreePort();
  const gatewayHandle = await startLocalWebhookGateway(handle, {
    host: "127.0.0.1",
    port
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
      body: JSON.stringify({
        requester: {
          externalSessionId: "beta-session",
          externalUserId: "beta-user",
          externalUserLabel: "Beta User"
        },
        taskInput: "beta gateway run"
      }),
      headers: {
        "Content-Type": "application/json"
      },
      method: "POST"
    });
    const payload = (await response.json()) as {
      result: {
        output: string | null;
        status: string;
      };
    };

    return {
      ok: response.ok && payload.result.status === "succeeded",
      output: payload.result.output,
      status: payload.result.status
    };
  } finally {
    await gatewayHandle.manager.stopAll();
    handle.close();
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate port for beta readiness check.");
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
  return port;
}

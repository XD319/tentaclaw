import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { resolvePublicOutboundTarget } from "../../core/outbound-url.js";
import { readScheduleWebhookUrl } from "../scheduler/schedule-delivery.js";
import type { ScheduleRecord } from "../../types/index.js";

export interface ScheduleWebhookPayload {
  category: "task_completed" | "task_failed";
  errorCode: string | null;
  errorMessage: string | null;
  output: string | null;
  runId: string;
  scheduleId: string;
  scheduleName: string;
  status: string;
  taskId: string | null;
}

export interface WebhookDeliveryServiceDependencies {
  fetchImpl?: typeof fetch;
  onFailure?: (input: { errorMessage: string; runId: string; scheduleId: string; webhookUrl: string }) => void;
}

export class WebhookDeliveryService {
  public constructor(private readonly dependencies: WebhookDeliveryServiceDependencies) {}

  public async deliverScheduleOutcome(schedule: ScheduleRecord, payload: ScheduleWebhookPayload): Promise<void> {
    const webhookUrl = readScheduleWebhookUrl(schedule);
    if (webhookUrl === null) {
      return;
    }
    try {
      if (this.dependencies.fetchImpl !== undefined) {
        const response = await this.dependencies.fetchImpl(webhookUrl, {
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          redirect: "manual"
        });
        if (!response.ok) {
          throw new Error(`Webhook responded with status ${response.status}`);
        }
      } else {
        await postToResolvedPublicTarget(webhookUrl, payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Schedule webhook delivery failed";
      this.dependencies.onFailure?.({ errorMessage: message, runId: payload.runId, scheduleId: payload.scheduleId, webhookUrl });
    }
  }
}

async function postToResolvedPublicTarget(webhookUrl: string, payload: ScheduleWebhookPayload): Promise<void> {
  const target = await resolvePublicOutboundTarget(webhookUrl);
  const body = JSON.stringify(payload);
  await new Promise<void>((resolve, reject) => {
    const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = request(target.url, {
      headers: { "Content-Length": Buffer.byteLength(body), "Content-Type": "application/json" },
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      method: "POST"
    }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300) {
        resolve();
      } else {
        reject(new Error(`Webhook responded with status ${status}`));
      }
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

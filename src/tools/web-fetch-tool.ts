import { z } from "zod";
import { parse } from "node-html-parser";

import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  SandboxWebPlan,
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

export interface WebFetchClient {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

interface PreparedWebFetchInput {
  maxBytes: number;
  maxRedirects: number;
  plan: SandboxWebPlan;
}

const webFetchSchema = z.object({
  maxBytes: z.number().int().positive().max(200_000).default(32_768),
  maxRedirects: z.number().int().min(0).max(5).default(2),
  url: z.string().url()
});

export class WebFetchTool implements ToolDefinition<typeof webFetchSchema, PreparedWebFetchInput> {
  public readonly name = "web_fetch";
  public readonly description =
    "Fetch a public text-oriented HTTP resource through a sandboxed allowlist.";
  public readonly capability = "network.fetch_public_readonly" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "cheap" as const;
  public readonly sideEffectLevel = "external_read_only" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = webFetchSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      maxBytes: {
        type: "number"
      },
      maxRedirects: {
        type: "number"
      },
      url: {
        type: "string"
      }
    },
    required: ["url"],
    type: "object"
  };

  public constructor(
    private readonly sandboxService: SandboxService,
    private readonly client: WebFetchClient = {
      fetch: (input, init) => fetch(input, init)
    }
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    return {
      available: true,
      reason: "web fetch availability controlled by sandbox host allowlist"
    };
  }

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedWebFetchInput> {
    void context;
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareWebFetch(parsedInput.url);

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Fetch ${plan.url}`
      },
      preparedInput: {
        maxBytes: parsedInput.maxBytes,
        maxRedirects: parsedInput.maxRedirects,
        plan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedWebFetchInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const requestTrace: Array<{ status: number; url: string }> = [];
    const response = await this.followRedirects(
      input.plan.url,
      input.maxRedirects,
      requestTrace,
      context.signal
    );
    const body = await response.text();
    const normalized = normalizeWebBody(body, response.headers.get("content-type"));
    const truncatedBody = normalized.content.slice(0, input.maxBytes);
    if (!response.ok) {
      return {
        details: {
          redirectTrace: requestTrace,
          status: response.status,
          url: response.url || input.plan.url
        },
        errorCode: "tool_execution_error",
        errorMessage: `Web fetch failed with HTTP status ${response.status}.`,
        success: false
      };
    }

    return {
      artifacts: [
        {
          artifactType: "web_response",
          content: {
            body: truncatedBody,
            extractedTitle: normalized.title,
            headers: {
              contentType: response.headers.get("content-type")
            },
            redirectTrace: requestTrace,
            status: response.status,
            url: response.url || input.plan.url
          },
          uri: response.url || input.plan.url
        }
      ],
      output: {
        body: truncatedBody,
        contentType: response.headers.get("content-type"),
        extractedTitle: normalized.title,
        redirectTrace: requestTrace,
        status: response.status,
        truncated: normalized.content.length > truncatedBody.length,
        url: response.url || input.plan.url
      },
      success: true,
      summary: `Fetched ${response.url || input.plan.url}`
    };
  }

  private async followRedirects(
    initialUrl: string,
    maxRedirects: number,
    requestTrace: Array<{ status: number; url: string }>,
    signal: AbortSignal
  ): Promise<Response> {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await this.client.fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal
      });
      requestTrace.push({
        status: response.status,
        url: currentUrl
      });

      if (!isRedirectStatus(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (location === null || location.trim().length === 0) {
        return response;
      }
      if (redirectCount >= maxRedirects) {
        return response;
      }

      const nextUrl = new URL(location, currentUrl).toString();
      this.sandboxService.prepareWebFetch(nextUrl);
      currentUrl = nextUrl;
    }

    return this.client.fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal
    });
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeWebBody(
  body: string,
  contentType: string | null
): {
  content: string;
  title: string | null;
} {
  if (contentType?.toLowerCase().includes("text/html") !== true) {
    return {
      content: body,
      title: null
    };
  }

  const root = parse(body);
  root.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
  const title = root.querySelector("title")?.text.trim() ?? null;
  const text = root.text.replace(/\s+/gu, " ").trim();
  return {
    content: text,
    title
  };
}

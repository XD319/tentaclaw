import { z } from "zod";

import type { SandboxService } from "../sandbox/sandbox-service";
import type {
  SandboxWebPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types";

export interface WebFetchClient {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

interface PreparedWebFetchInput {
  maxBytes: number;
  plan: SandboxWebPlan;
}

const webFetchSchema = z.object({
  maxBytes: z.number().int().positive().max(200_000).default(32_768),
  url: z.string().url()
});

export class WebFetchTool implements ToolDefinition<typeof webFetchSchema, PreparedWebFetchInput> {
  public readonly name = "web_fetch";
  public readonly description =
    "Fetch a text-oriented HTTP resource through a sandboxed allowlist.";
  public readonly capability = "network.fetch" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly inputSchema = webFetchSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      maxBytes: {
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
        plan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedWebFetchInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const response = await this.client.fetch(input.plan.url, {
      method: input.plan.method,
      signal: context.signal
    });

    const body = await response.text();
    const truncatedBody = body.slice(0, input.maxBytes);
    if (!response.ok) {
      return {
        details: {
          status: response.status,
          url: input.plan.url
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
            headers: {
              contentType: response.headers.get("content-type")
            },
            status: response.status,
            url: input.plan.url
          },
          uri: input.plan.url
        }
      ],
      output: {
        body: truncatedBody,
        contentType: response.headers.get("content-type"),
        status: response.status,
        truncated: body.length > truncatedBody.length,
        url: input.plan.url
      },
      success: true,
      summary: `Fetched ${input.plan.url}`
    };
  }
}

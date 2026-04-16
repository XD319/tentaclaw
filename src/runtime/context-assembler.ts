import type {
  ConversationMessage,
  ProviderInput,
  ProviderToolDescriptor,
  TaskRecord,
  TokenBudget
} from "../types";

export interface ContextAssemblerInput {
  availableTools: ProviderToolDescriptor[];
  iteration: number;
  memoryContext: string[];
  messages: ConversationMessage[];
  signal: AbortSignal;
  task: TaskRecord;
  tokenBudget: TokenBudget;
}

export class ExecutionContextAssembler {
  public assemble(input: ContextAssemblerInput): ProviderInput {
    return {
      availableTools: input.availableTools,
      iteration: input.iteration,
      memoryContext: input.memoryContext,
      messages: input.messages,
      signal: input.signal,
      task: input.task,
      tokenBudget: input.tokenBudget
    };
  }

  public buildInitialMessages(task: TaskRecord, availableTools: ProviderToolDescriptor[]): ConversationMessage[] {
    const systemMessage = [
      "You are a single-agent runtime.",
      "Use tools only when needed.",
      `Available tools: ${availableTools.map((tool) => tool.name).join(", ")}.`
    ].join(" ");

    return [
      {
        content: systemMessage,
        role: "system"
      },
      {
        content: task.input,
        role: "user"
      }
    ];
  }
}

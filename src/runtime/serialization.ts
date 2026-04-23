import type { JsonObject, JsonValue, TokenBudget } from "../types/index.js";

export function tokenBudgetToJson(tokenBudget: TokenBudget): JsonObject {
  return {
    inputLimit: tokenBudget.inputLimit,
    outputLimit: tokenBudget.outputLimit,
    reservedOutput: tokenBudget.reservedOutput,
    usedInput: tokenBudget.usedInput,
    usedOutput: tokenBudget.usedOutput
  };
}

export function safePreview(value: JsonValue, maxLength = 240): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);

  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

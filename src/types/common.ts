export type ISODateString = string;

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface TokenBudget {
  inputLimit: number;
  outputLimit: number;
  reservedOutput: number;
  usedInput: number;
  usedOutput: number;
  usedCostUsd?: number;
}

export interface ActorDescriptor {
  kind: "cli" | "provider" | "runtime" | "tool";
  name: string;
}

export interface CommandResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

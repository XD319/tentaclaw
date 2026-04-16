export function parseJsonValue<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function serializeJsonValue(value: unknown): string {
  return JSON.stringify(value);
}

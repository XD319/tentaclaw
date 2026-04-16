import type { TaskRecord } from "../types";

export class MemoryPlane {
  public buildContext(task: TaskRecord): Promise<string[]> {
    void task;
    return Promise.resolve([]);
  }
}

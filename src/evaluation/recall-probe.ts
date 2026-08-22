import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApplication } from "../runtime/index.js";
import { mergeMemoryContextIntoMessages } from "../runtime/context-assembler.js";
import { RecallEngine } from "../recall/recall-engine.js";
import type { ContextFragment, ConversationMessage } from "../types/index.js";
import type { EvalMemoryState } from "./schema.js";
import { materializeMemoryState, prepareMemoryEvalWorkspace } from "./memory-state.js";

export interface RecallProbeResult {
  injected: boolean;
  k: number;
  query: string;
  recalledTitles: string[];
  recallAtK: number;
  titles: string[];
}

export async function runRecallProbe(input: {
  expectedTitles: string[];
  k?: number;
  memoryState: EvalMemoryState;
  query: string;
}): Promise<RecallProbeResult> {
  const k = input.k ?? Math.max(1, input.expectedTitles.length);
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-eval-recall-"));
  const handle = await (async () => {
    await prepareMemoryEvalWorkspace(workspaceRoot, input.memoryState);
    return createApplication(workspaceRoot, {
      config: { databasePath: ":memory:", workspaceRoot },
      provider: {
        generate: () => Promise.resolve({
          kind: "final",
          message: "READY",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        }),
        model: "recall-probe",
        name: "recall-probe"
      },
      scheduler: { autoStart: false }
    });
  })();
  try {
    materializeMemoryState(handle, input.memoryState, workspaceRoot);
    const memories = handle.infrastructure.storage.memories.list({
      includeExpired: false,
      scope: "project",
      scopeKey: workspaceRoot
    });
    const ranked = new RecallEngine().rankMemory(memories, input.query, k);
    const recalledTitles = ranked.map((candidate) => candidate.memory.title);
    const fragments: ContextFragment[] = ranked.map((candidate) => ({
      confidence: candidate.memory.confidence,
      explanation: candidate.explanation,
      fragmentId: candidate.memory.memoryId,
      memoryId: candidate.memory.memoryId,
      privacyLevel: candidate.memory.privacyLevel,
      retentionPolicy: candidate.memory.retentionPolicy,
      scope: candidate.memory.scope,
      sourceType: candidate.memory.sourceType,
      status: candidate.memory.status,
      text: candidate.memory.content,
      title: candidate.memory.title
    }));
    const messages: ConversationMessage[] = [{ content: "system", role: "system" }];
    const merged = mergeMemoryContextIntoMessages(messages, fragments);
    const injectedContent = merged.messages.find((message) => message.role === "system" && message.content.includes("Recalled context:"))?.content ?? "";
    const injected = input.expectedTitles.every((title) => injectedContent.includes(title));
    const hits = input.expectedTitles.filter((title) => recalledTitles.slice(0, k).includes(title)).length;
    return {
      injected,
      k,
      query: input.query,
      recallAtK: input.expectedTitles.length === 0 ? 1 : hits / input.expectedTitles.length,
      recalledTitles,
      titles: input.expectedTitles
    };
  } finally {
    handle.close();
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

import type { ExperienceDraft, TraceEvent } from "../types/index.js";
import type { TraceService } from "../tracing/trace-service.js";

import type { ExperiencePlane } from "./experience-plane.js";

export interface ExperienceCollectorDependencies {
  experiencePlane: ExperiencePlane;
  traceService: TraceService;
}

export class ExperienceCollector {
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly dependencies: ExperienceCollectorDependencies) {}

  public start(): void {
    if (this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = this.dependencies.traceService.subscribe((event) => {
      const draft = draftFromTraceEvent(event);
      if (draft !== null) {
        this.dependencies.experiencePlane.capture(draft);
      }
    });
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

function draftFromTraceEvent(event: TraceEvent): ExperienceDraft | null {
  switch (event.eventType) {
    case "task_success":
      return createDraft({
        content: event.payload.outputSummary,
        sourceLabel: "Task success",
        sourceType: "task",
        status: "candidate",
        summary: event.payload.outputSummary,
        taskId: event.taskId,
        taskStatus: event.payload.status,
        title: "Task outcome",
        type: "task_outcome",
        valueScore: 0.62,
        workspace: event.payload.cwd
      });
    case "task_failure":
      return createDraft({
        content: `${event.payload.errorCode}: ${event.payload.errorMessage}`,
        errorCodes: [event.payload.errorCode],
        sourceLabel: "Task failure",
        sourceType: "task",
        status: "candidate",
        summary: event.payload.errorMessage,
        taskId: event.taskId,
        taskStatus: event.payload.status,
        title: "Failure lesson",
        type: "failure_lesson",
        valueScore: 0.76,
        workspace: event.payload.cwd
      });
    case "review_resolved":
      return createDraft({
        content: `Review ${event.payload.status} for ${event.payload.toolName}.`,
        reviewerId: event.payload.reviewerId,
        sourceLabel: "Review resolved",
        sourceType: "reviewer",
        status: "candidate",
        summary: `Review ${event.payload.status} for ${event.payload.toolName}`,
        taskId: event.taskId,
        title: "Review feedback",
        toolCallId: event.payload.toolCallId,
        type: "review_feedback",
        valueScore: event.payload.status === "approved" ? 0.55 : 0.72,
        workspace: event.taskId
      });
    case "pre_compress":
      return createDraft({
        content: `Session had ${event.payload.messageCount} messages before ${event.payload.reason}.`,
        sourceLabel: "Pre-compress hook",
        sourceType: "session_end",
        status: "candidate",
        summary: `Pre-compress at ${event.payload.messageCount} messages`,
        taskId: event.taskId,
        taskStatus: "running",
        title: "Pre-compress signal",
        type: "pattern",
        valueScore: 0.35,
        workspace: event.taskId
      });
    case "tool_call_finished":
      return createDraft({
        content: event.payload.outputPreview,
        sourceLabel: `Tool result: ${event.payload.toolName}`,
        sourceType: "tool_result",
        status: "candidate",
        summary: event.payload.summary,
        taskId: event.taskId,
        title: `Tool result: ${event.payload.toolName}`,
        toolCallId: event.payload.toolCallId,
        type: "pattern",
        valueScore: 0.42,
        workspace: event.taskId
      });
    case "tool_call_failed":
      return createDraft({
        content: `${event.payload.errorCode}: ${event.payload.errorMessage}`,
        errorCodes: [event.payload.errorCode],
        sourceLabel: `Tool failure: ${event.payload.toolName}`,
        sourceType: "tool_result",
        status: "candidate",
        summary: event.payload.errorMessage,
        taskId: event.taskId,
        title: `Tool failure: ${event.payload.toolName}`,
        toolCallId: event.payload.toolCallId,
        type: "gotcha",
        valueScore: 0.7,
        workspace: event.taskId
      });
    case "session_end":
      return createDraft({
        content: event.payload.summary,
        sourceLabel: "Session end",
        sourceType: "session_end",
        status: "candidate",
        summary: event.payload.summary,
        taskId: event.taskId,
        taskStatus: event.payload.status,
        title: "Session outcome",
        type: event.payload.status === "succeeded" ? "task_outcome" : "failure_lesson",
        valueScore: event.payload.status === "succeeded" ? 0.5 : 0.65,
        workspace: event.taskId
      });
    case "delegation_complete":
      return createDraft({
        content: event.payload.summary,
        sourceLabel: "Delegation complete",
        sourceType: "delegation",
        status: "candidate",
        summary: event.payload.summary,
        taskId: event.taskId,
        taskStatus: event.payload.status,
        title: "Delegation outcome",
        type: "task_outcome",
        valueScore: 0.58,
        workspace: event.taskId
      });
    default:
      return null;
  }
}

function createDraft(input: {
  content: string;
  errorCodes?: string[];
  reviewerId?: string | null;
  sourceLabel: string;
  sourceType: ExperienceDraft["sourceType"];
  status: ExperienceDraft["status"];
  summary: string;
  taskId: string;
  taskStatus?: string;
  title: string;
  toolCallId?: string | null;
  type: ExperienceDraft["type"];
  valueScore: number;
  workspace: string;
}): ExperienceDraft {
  const keywords = tokenizeLoose(`${input.title} ${input.summary} ${input.content}`);
  const phrases = buildPhrases(keywords);
  return {
    confidence: input.type === "failure_lesson" || input.type === "gotcha" ? 0.74 : 0.68,
    content: input.content,
    indexSignals: {
      errorCodes: input.errorCodes ?? [],
      paths: keywords.filter((token) => token.includes("/") || token.includes("\\")),
      phrases,
      reviewers: input.reviewerId === null || input.reviewerId === undefined ? [] : [input.reviewerId],
      scopes: [`project:${input.workspace}`],
      sourceTypes: [input.sourceType],
      statuses: [input.status],
      taskStatuses: input.taskStatus === undefined ? [] : [input.taskStatus],
      tokens: keywords,
      types: [input.type],
      valueScore: input.valueScore
    },
    keywordPhrases: phrases,
    keywords,
    metadata: {
      collector: "trace",
      taskStatus: input.taskStatus ?? null
    },
    promotionTarget: input.type === "failure_lesson" || input.type === "task_outcome" ? "project_memory" : null,
    provenance: {
      reviewerId: input.reviewerId ?? null,
      sourceLabel: input.sourceLabel,
      taskId: input.taskId,
      toolCallId: input.toolCallId ?? null,
      traceEventId: null
    },
    scope: {
      paths: [],
      scope: "project",
      scopeKey: input.workspace
    },
    sourceType: input.sourceType,
    status: input.status,
    summary: input.summary,
    title: input.title,
    type: input.type,
    valueScore: input.valueScore
  };
}

function tokenizeLoose(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_\u4e00-\u9fa5/\\.:-]+/u)
        .filter((token) => token.length >= 2)
    )
  ];
}

function buildPhrases(tokens: string[]): string[] {
  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return [...new Set(phrases)];
}

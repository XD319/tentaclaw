import type { ExperienceQuery, ExperienceRecord, MemoryRecallCandidate, MemoryRecord } from "../types/index.js";

export interface ExperienceRecallRequest {
  query: string;
  filters?: ExperienceQuery;
  limit: number;
}

export interface ExperienceRecallCandidate {
  experience: ExperienceRecord;
  keywordScore: number;
  phraseScore: number;
  structuredScore: number;
  statusScore: number;
  confidenceScore: number;
  valueScore: number;
  finalScore: number;
  explanation: string;
  downrankReasons: string[];
}

export class RecallEngine {
  public scoreMemory(memory: MemoryRecord, queryTokens: string[]): MemoryRecallCandidate {
    const keywordScore = overlapRatio(memory.keywords, queryTokens);
    const freshnessScore = memory.status === "stale" ? 0.2 : memory.status === "candidate" ? 0.7 : 1;
    const confidenceScore = memory.confidence;
    const recencyScore = computeRecencyScore(memory.createdAt);
    const pathSignal = computePathSignal(memory, queryTokens);
    const failureSignal = computeFailureSignal(memory, queryTokens);
    const finalScore = Number(
      (
        keywordScore * 0.35 +
        freshnessScore * 0.15 +
        confidenceScore * 0.25 +
        recencyScore * 0.15 +
        pathSignal * 0.1 +
        failureSignal
      ).toFixed(4)
    );
    const downrankReasons: string[] = [];

    if (memory.status === "stale") {
      downrankReasons.push("stale_memory");
    }
    if (memory.status === "candidate") {
      downrankReasons.push("candidate_unverified");
    }
    if (memory.privacyLevel === "restricted" && memory.scope !== "working") {
      downrankReasons.push("privacy_restricted_cross_session");
    }
    if (memory.confidence < 0.75) {
      downrankReasons.push("low_confidence");
    }
    if (pathSignal === 0 && queryTokens.some((token) => token.includes("/") || token.includes("\\"))) {
      downrankReasons.push("path_mismatch");
    }
    if (failureSignal < 0) {
      downrankReasons.push("failure_noise");
    }

    return {
      confidenceScore,
      downrankReasons,
      explanation: `scope=${memory.scope}; keyword=${keywordScore.toFixed(2)}; freshness=${freshnessScore.toFixed(2)}; confidence=${confidenceScore.toFixed(2)}; recency=${recencyScore.toFixed(2)}; pathSignal=${pathSignal.toFixed(2)}; failureSignal=${failureSignal.toFixed(2)}; status=${memory.status}; privacy=${memory.privacyLevel}; source=${memory.source.label}`,
      finalScore,
      freshnessScore,
      keywordScore,
      memory
    };
  }

  public rankMemory(memories: MemoryRecord[], query: string, limit: number): MemoryRecallCandidate[] {
    const queryTokens = tokenize(query);
    return memories
      .map((memory) => this.scoreMemory(memory, queryTokens))
      .filter((candidate) => candidate.finalScore > 0)
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, limit);
  }

  public rankExperiences(
    experiences: ExperienceRecord[],
    request: ExperienceRecallRequest
  ): ExperienceRecallCandidate[] {
    const queryTokens = tokenize(request.query);
    const queryText = normalizeText(request.query);

    return experiences
      .filter((experience) => matchesStructuredFilters(experience, request.filters))
      .map((experience) => scoreExperience(experience, queryTokens, queryText))
      .filter((candidate) => candidate.keywordScore > 0 || candidate.phraseScore > 0 || candidate.structuredScore > 0)
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, request.limit);
  }
}

export function tokenize(value: string): string[] {
  return uniqueStrings(
    value
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fa5/\\.:-]+/u)
      .filter((token) => token.length >= 2)
  );
}

export function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  const leftTokens = uniqueStrings(left);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  return overlap / Math.max(1, Math.min(leftTokens.length, rightSet.size));
}

export function extractKeywordPhrases(value: string): string[] {
  const tokens = tokenize(value);
  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return uniqueStrings(phrases);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function scoreExperience(
  experience: ExperienceRecord,
  queryTokens: string[],
  queryText: string
): ExperienceRecallCandidate {
  const allTokens = uniqueStrings([
    ...experience.keywords,
    ...experience.indexSignals.tokens,
    experience.type,
    experience.sourceType,
    experience.status,
    ...experience.indexSignals.errorCodes.map((code) => code.toLowerCase()),
    ...experience.indexSignals.paths.map((path) => path.toLowerCase())
  ]);
  const keywordScore = overlapRatio(allTokens, queryTokens);
  const phraseScore = scorePhrases(experience, queryText);
  const structuredScore = scoreStructuredSignals(experience, queryTokens);
  const statusScore = scoreExperienceStatus(experience.status);
  const confidenceScore = experience.confidence;
  const valueScore = experience.valueScore;
  const finalScore = Number(
    (
      structuredScore * 0.25 +
      keywordScore * 0.25 +
      phraseScore * 0.15 +
      statusScore * 0.1 +
      confidenceScore * 0.1 +
      valueScore * 0.15
    ).toFixed(4)
  );
  const downrankReasons: string[] = [];

  if (experience.status === "rejected") {
    downrankReasons.push("rejected_experience");
  }
  if (experience.status === "stale") {
    downrankReasons.push("stale_experience");
  }
  if (experience.valueScore < 0.4) {
    downrankReasons.push("low_value");
  }
  if (experience.confidence < 0.65) {
    downrankReasons.push("low_confidence");
  }

  return {
    confidenceScore,
    downrankReasons,
    experience,
    explanation: `type=${experience.type}; source=${experience.sourceType}; status=${experience.status}; keyword=${keywordScore.toFixed(2)}; phrase=${phraseScore.toFixed(2)}; structured=${structuredScore.toFixed(2)}; confidence=${confidenceScore.toFixed(2)}; value=${valueScore.toFixed(2)}`,
    finalScore,
    keywordScore,
    phraseScore,
    statusScore,
    structuredScore,
    valueScore
  };
}

function matchesStructuredFilters(
  experience: ExperienceRecord,
  filters: ExperienceQuery | undefined
): boolean {
  if (filters === undefined) {
    return true;
  }

  return (
    (filters.type === undefined || experience.type === filters.type) &&
    (filters.sourceType === undefined || experience.sourceType === filters.sourceType) &&
    (filters.status === undefined || experience.status === filters.status) &&
    (filters.statuses === undefined || filters.statuses.includes(experience.status)) &&
    (filters.minValueScore === undefined || experience.valueScore >= filters.minValueScore) &&
    (filters.taskId === undefined || experience.provenance.taskId === filters.taskId) &&
    (filters.reviewerId === undefined || experience.provenance.reviewerId === filters.reviewerId) &&
    (filters.scope === undefined || experience.scope.scope === filters.scope) &&
    (filters.scopeKey === undefined || experience.scope.scopeKey === filters.scopeKey)
  );
}

function scorePhrases(experience: ExperienceRecord, queryText: string): number {
  const phrases = uniqueStrings([...experience.keywordPhrases, ...experience.indexSignals.phrases]);
  if (phrases.length === 0) {
    return 0;
  }

  const matches = phrases.filter((phrase) => queryText.includes(normalizeText(phrase))).length;
  return matches / phrases.length;
}

function scoreStructuredSignals(experience: ExperienceRecord, queryTokens: string[]): number {
  const signals = [
    ...experience.indexSignals.paths,
    ...experience.indexSignals.errorCodes,
    ...experience.indexSignals.reviewers,
    ...experience.indexSignals.taskStatuses,
    ...experience.indexSignals.scopes
  ].map((signal) => signal.toLowerCase());

  if (signals.length === 0) {
    return 0;
  }

  const query = new Set(queryTokens);
  const matches = signals.filter((signal) => query.has(signal) || queryTokens.some((token) => signal.includes(token)));
  return matches.length / signals.length;
}

function scoreExperienceStatus(status: ExperienceRecord["status"]): number {
  if (status === "promoted") {
    return 1;
  }
  if (status === "accepted") {
    return 0.9;
  }
  if (status === "candidate") {
    return 0.65;
  }
  if (status === "stale") {
    return 0.2;
  }
  return 0;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function computeRecencyScore(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) {
    return 0.5;
  }
  const ageHours = Math.max(0, (Date.now() - created) / 3_600_000);
  if (ageHours <= 6) {
    return 1;
  }
  if (ageHours <= 24) {
    return 0.8;
  }
  if (ageHours <= 72) {
    return 0.5;
  }
  return 0.2;
}

function computePathSignal(memory: MemoryRecord, queryTokens: string[]): number {
  const pathLikeTokens = queryTokens.filter((token) => token.includes("/") || token.includes("\\"));
  if (pathLikeTokens.length === 0) {
    return 0.6;
  }
  const memoryText = `${memory.title} ${memory.summary} ${memory.content}`.toLowerCase();
  return pathLikeTokens.some((token) => memoryText.includes(token.toLowerCase())) ? 1 : 0;
}

function computeFailureSignal(memory: MemoryRecord, queryTokens: string[]): number {
  const failureTokens = ["error", "failed", "exception", "traceback", "timeout"];
  const queryWantsFailure = queryTokens.some((token) => failureTokens.includes(token));
  const memoryText = `${memory.title} ${memory.summary}`.toLowerCase();
  const memoryLooksFailure = failureTokens.some((token) => memoryText.includes(token));

  if (queryWantsFailure && memoryLooksFailure) {
    return 0.1;
  }
  if (!queryWantsFailure && memoryLooksFailure) {
    return -0.1;
  }
  return 0;
}

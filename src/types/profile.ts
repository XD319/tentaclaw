export const AGENT_PROFILE_IDS = ["planner", "executor", "reviewer"] as const;

export type AgentProfileId = (typeof AGENT_PROFILE_IDS)[number];

export interface AgentProfile {
  id: AgentProfileId;
  displayName: string;
  description: string;
  systemPrompt: string;
  /** @deprecated Runtime tool visibility is governed by policy/availability, not profile allowlists. */
  allowedToolNames: string[];
}

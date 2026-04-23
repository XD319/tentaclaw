import { z } from "zod";

import type { AgentProfile, AgentProfileId } from "../types/index.js";

const agentProfileSchema = z.object({
  allowedToolNames: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
  displayName: z.string().min(1),
  id: z.enum(["planner", "executor", "reviewer"]),
  systemPrompt: z.string().min(1)
});

export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  {
    allowedToolNames: ["file_read", "skill_view", "web_fetch"],
    description: "Read-oriented planning profile with no direct mutation tools.",
    displayName: "Planner",
    id: "planner",
    systemPrompt:
      "You are the planner profile. Break down the task, prefer read-only inspection, and avoid making changes unless explicitly delegated."
  },
  {
    allowedToolNames: ["file_read", "file_write", "shell", "skill_view", "test_run", "web_fetch"],
    description: "Execution profile for controlled implementation work.",
    displayName: "Executor",
    id: "executor",
    systemPrompt:
      "You are the executor profile. Complete the task end to end, use tools when justified, and keep outputs grounded in observable evidence."
  },
  {
    allowedToolNames: ["file_read", "skill_view", "web_fetch"],
    description: "Reviewer profile focused on checks, risk discovery, and output critique.",
    displayName: "Reviewer",
    id: "reviewer",
    systemPrompt:
      "You are the reviewer profile. Inspect work critically, surface risks, and provide review-oriented feedback without mutating the workspace."
  }
];

export class AgentProfileRegistry {
  private readonly profiles = new Map<AgentProfileId, AgentProfile>();

  public constructor(profiles: AgentProfile[] = DEFAULT_AGENT_PROFILES) {
    for (const profile of profiles) {
      const parsedProfile = agentProfileSchema.parse(profile);
      this.profiles.set(parsedProfile.id, parsedProfile);
    }
  }

  public get(profileId: AgentProfileId): AgentProfile {
    const profile = this.profiles.get(profileId);
    if (profile === undefined) {
      throw new Error(`Agent profile ${profileId} was not registered.`);
    }

    return profile;
  }

  public list(): AgentProfile[] {
    return [...this.profiles.values()];
  }
}

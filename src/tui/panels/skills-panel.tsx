import React from "react";
import { Box, Text } from "ink";

import type { SkillItemViewModel } from "../view-models/runtime-dashboard";

export interface SkillsPanelProps {
  skills: SkillItemViewModel[];
}

export function SkillsPanel({ skills }: SkillsPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">Skills</Text>
      {skills.length === 0 ? (
        <Text color="gray">No enabled skills found.</Text>
      ) : (
        skills.map((skill) => (
          <Box key={skill.id} marginBottom={1} flexDirection="column">
            <Text color="green">
              {skill.title} [{skill.category}] source={skill.source} platforms={skill.platformSummary}
            </Text>
            <Text color="gray">id={skill.id}</Text>
            <Text color="gray">tags={skill.tags} experiences={skill.experienceIds}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

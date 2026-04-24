import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { SkillItemViewModel } from "../view-models/runtime-dashboard.js";

export interface SkillsPanelProps {
  skills: SkillItemViewModel[];
}

export function SkillsPanel({ skills }: SkillsPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>Skills</Text>
      {skills.length === 0 ? (
        <Text color={theme.muted}>No enabled skills found.</Text>
      ) : (
        skills.map((skill) => (
          <Box key={skill.id} borderStyle="classic" borderColor={theme.border} marginBottom={1} flexDirection="column" paddingX={1}>
            <Text color={theme.success}>
              {skill.title} [{skill.category}] source={skill.source} platforms={skill.platformSummary}
            </Text>
            <Text color={theme.muted}>id={skill.id}</Text>
            <Text color={theme.muted} wrap="wrap">
              tags={skill.tags} experiences={skill.experienceIds}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

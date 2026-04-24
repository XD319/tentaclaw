import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { ExperienceHitViewModel } from "../view-models/runtime-dashboard.js";

export interface ExperiencePanelProps {
  experiences: ExperienceHitViewModel[];
}

export function ExperiencePanel({ experiences }: ExperiencePanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>Experience</Text>
      {experiences.length === 0 ? (
        <Text color={theme.muted}>No experience records captured for this task.</Text>
      ) : (
        experiences.map((experience) => (
          <Box key={experience.experienceId} borderStyle="classic" borderColor={theme.border} marginBottom={1} flexDirection="column" paddingX={1}>
            <Text color={experience.status === "accepted" || experience.status === "promoted" ? theme.success : theme.warn}>
              {experience.title} [{experience.type}] status={experience.status} value=
              {experience.valueScore.toFixed(2)}
            </Text>
            <Text color={theme.muted}>
              source={experience.sourceType} target={experience.promotionTarget} match=
              {experience.matchScore === null ? "-" : experience.matchScore.toFixed(2)}
            </Text>
            <Text color={theme.muted} wrap="wrap">
              {experience.provenance}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

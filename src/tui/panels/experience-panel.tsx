import React from "react";
import { Box, Text } from "ink";

import type { ExperienceHitViewModel } from "../view-models/runtime-dashboard.js";

export interface ExperiencePanelProps {
  experiences: ExperienceHitViewModel[];
}

export function ExperiencePanel({ experiences }: ExperiencePanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">Experience</Text>
      {experiences.length === 0 ? (
        <Text color="gray">No experience records captured for this task.</Text>
      ) : (
        experiences.map((experience) => (
          <Box key={experience.experienceId} marginBottom={1} flexDirection="column">
            <Text color={experience.status === "accepted" || experience.status === "promoted" ? "green" : "yellow"}>
              {experience.title} [{experience.type}] status={experience.status} value=
              {experience.valueScore.toFixed(2)}
            </Text>
            <Text color="gray">
              source={experience.sourceType} target={experience.promotionTarget} match=
              {experience.matchScore === null ? "-" : experience.matchScore.toFixed(2)}
            </Text>
            <Text color="gray">{experience.provenance}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

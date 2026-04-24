import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";

export interface BannerProps {
  details?: string[];
  kicker?: string;
  meta?: string[];
  productName: string;
  subtitle?: string;
  title: string;
}

function BannerBase({ details = [], kicker, meta = [], productName, subtitle, title }: BannerProps): React.ReactElement {
  const segments = [
    title,
    ...(subtitle !== undefined && subtitle.length > 0 ? [subtitle] : []),
    ...meta,
    ...details,
    ...(kicker !== undefined && kicker.length > 0 ? [kicker] : [])
  ];

  return (
    <Box>
      <Text wrap="truncate-end">
        <Text bold color={theme.bannerAccent}>
          {productName}
        </Text>
        {segments.length > 0 ? <Text color={theme.muted}>{"  |  " + segments.join("  |  ")}</Text> : null}
      </Text>
    </Box>
  );
}

export const Banner = React.memo(BannerBase);

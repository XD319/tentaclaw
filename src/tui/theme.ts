type ThemeMode = "auto" | "dark" | "light";

function resolveThemeMode(): ThemeMode {
  const rawMode = process.env.AUTOTALON_TUI_THEME?.trim().toLowerCase();
  if (rawMode === "dark" || rawMode === "light" || rawMode === "auto") {
    return rawMode;
  }
  return "auto";
}

function detectTerminalBrightness(): "dark" | "light" {
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg !== undefined) {
    const parts = colorFgBg.split(";").map((value) => Number.parseInt(value, 10));
    const background = parts.at(-1);
    if (background !== undefined && Number.isInteger(background)) {
      return background >= 7 ? "light" : "dark";
    }
  }
  return "dark";
}

function buildTheme(mode: ThemeMode) {
  const effectiveMode = mode === "auto" ? detectTerminalBrightness() : mode;
  const onLight = effectiveMode === "light";

  return {
    accent: onLight ? "blue" : "cyan",
    agent: onLight ? "blue" : "cyan",
    bannerAccent: onLight ? "blue" : "cyan",
    border: onLight ? "gray" : "white",
    codeBg: "gray",
    danger: "red",
    emphasis: onLight ? "black" : "white",
    fg: onLight ? "black" : "white",
    heading: onLight ? "blue" : "magenta",
    inlineCode: onLight ? "blue" : "yellow",
    link: "blue",
    muted: "gray",
    panelTitle: onLight ? "blue" : "cyan",
    quote: onLight ? "blue" : "cyan",
    selection: onLight ? "blue" : "green",
    statusOk: "green",
    statusWarn: "yellow",
    success: "green",
    user: onLight ? "black" : "white",
    warn: "yellow"
  } as const;
}

/** Central palette for TUI surfaces (Ink named colors). */
export const theme = buildTheme(resolveThemeMode());

export function progressBar(filled: number, width: number, char = "#"): string {
  const n = Math.max(0, Math.min(width, Math.round((filled / 100) * width)));
  return char.repeat(n) + "-".repeat(width - n);
}

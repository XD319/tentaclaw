/** Central palette for chat TUI (Ink named colors). */
export const theme = {
  agent: "cyan",
  bannerAccent: "green",
  border: "gray",
  codeBg: "gray",
  emphasis: "white",
  heading: "magenta",
  inlineCode: "yellow",
  link: "blue",
  muted: "gray",
  quote: "cyan",
  statusOk: "green",
  statusWarn: "yellow",
  user: "white"
} as const;

export function progressBar(filled: number, width: number, char = "█"): string {
  const n = Math.max(0, Math.min(width, Math.round((filled / 100) * width)));
  return char.repeat(n) + "░".repeat(width - n);
}

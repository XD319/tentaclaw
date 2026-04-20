const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/gu;

const NON_PRINTABLE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function sanitizeTerminalText(input: string): string {
  return input
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(NON_PRINTABLE_PATTERN, "");
}

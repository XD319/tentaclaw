import clipboardy from "clipboardy";

export async function readClipboardText(): Promise<string> {
  return clipboardy.read();
}

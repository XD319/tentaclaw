/**
 * Shared ripgrep (rg) availability messaging for doctor, setup, and code search.
 */

export function ripgrepInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "install with `winget install BurntSushi.ripgrep.MSVC` or `choco install ripgrep`";
  }
  if (platform === "darwin") {
    return "install with `brew install ripgrep`";
  }
  return "install with your package manager (for example `sudo apt install ripgrep` or `sudo dnf install ripgrep`)";
}

export function formatRipgrepMissingDoctorIssue(
  platform: NodeJS.Platform = process.platform
): string {
  return (
    "ripgrep (rg) is not on PATH. Code search falls back to a slower Node walker; " +
    `${ripgrepInstallHint(platform)} (see docs/user/windows-troubleshooting.md).`
  );
}

export function formatRipgrepFallbackSummarySuffix(
  platform: NodeJS.Platform = process.platform
): string {
  return (
    "ripgrep unavailable, used Node filesystem scan; " +
    `${ripgrepInstallHint(platform)} (see docs/user/windows-troubleshooting.md)`
  );
}

export function isRipgrepMissingProcessError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return true;
  }
  // Windows often reports missing executables via spawn with status null + error.
  const errno = "errno" in error ? error.errno : undefined;
  return errno === -2 || errno === "ENOENT";
}

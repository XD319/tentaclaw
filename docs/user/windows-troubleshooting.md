# Windows troubleshooting

## Setup script (`setup.ps1`)

`./scripts/setup.ps1` installs dependencies, builds the project, and bootstraps workspace config. By default it also checks whether **ripgrep** (`rg`) and **git** are on `PATH` after the build (use `-CheckRipgrep:$false` or `-CheckGit:$false` to skip). If either tool is missing, the script prints install hints and links here; it does not auto-install them.

## Code search (`rg` / ripgrep)

`search_files` prefers **ripgrep** (`rg`) when it is on `PATH`. If `rg` is missing, the tool
falls back to a slower Node.js directory walk instead of crashing. Tool JSON output includes
`searchBackend: "rg" | "node"`; when Node is used, the result `summary` and `ripgrepGuidance`
field include install hints.

`talon doctor` warns on every platform when `rg` is missing. `./scripts/setup.ps1` also warns
on Windows after bootstrap.

Install ripgrep and ensure `rg --version` works in the same shell you use for `talon`:

- Windows: [Ripgrep releases](https://github.com/BurntSushi/ripgrep/releases) (add the install
  directory to `PATH`), or `winget install BurntSushi.ripgrep.MSVC` / `choco install ripgrep`
- macOS: `brew install ripgrep`
- Linux: `sudo apt install ripgrep` or `sudo dnf install ripgrep` (or your distro equivalent)

Run `talon doctor` (or `talon config doctor`) after installing; the report should no longer warn
about missing `rg`.

## Git

Several workspace commands rely on `git` (for example `git status`). On Windows, `talon doctor` and `./scripts/setup.ps1` warn when `git` is not on `PATH`. Install [Git for Windows](https://git-scm.com/download/win) (or `winget install Git.Git`) and confirm `git --version` works in your shell.

## PowerShell execution policy

If `npm` scripts fail with execution policy errors, run setup from an elevated or current-user scope:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

See also `docs/user/install.md` for `./scripts/setup.ps1`.

## SQLite locking

If CLI commands fail with `database is locked` while another `talon` process is running, stop the other process or wait for the writer to finish. The runtime uses WAL mode with a busy timeout, but long-running tasks can still hold write locks.

## Gateway rate limits

Gateway token-bucket state is persisted in SQLite (`gateway_rate_limits`) with a one-hour TTL, so rate limits survive process restarts within that window. Tune burst/refill in `.auto-talon/gateway.config.json` under `rateLimit`.

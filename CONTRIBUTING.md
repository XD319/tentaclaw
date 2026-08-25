# Contributing to AutoTalon

Thanks for your interest in AutoTalon. This guide covers developing from a
source checkout and validating a release. For usage, start with the
[README](README.md) and the [docs](docs/).

## Develop from source

This is the **developer** path. Day-to-day users should install from npm and use
`talon ...` instead — see the [README Install](README.md#install) section.

Requirements:

- Node.js `>=22.13.0`
- Corepack (bundled with Node.js) to pin the pinned pnpm version

Mock provider (no credentials):

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev provider setup mock
corepack pnpm dev provider test
corepack pnpm dev tui
```

Real provider: use the same flags as the README user path, with
`corepack pnpm dev` as the entrypoint. Examples:

```bash
corepack pnpm dev provider setup openai --api-key "$OPENAI_API_KEY"
corepack pnpm dev provider setup openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key "$DEEPSEEK_API_KEY"
corepack pnpm dev provider test
corepack pnpm dev tui
```

Provider config is user-level (global) by default; add `--workspace` for a
project-local override. Full provider examples (built-ins, DeepSeek, PowerShell):
[README → For users (npm)](README.md#for-users-npm).

Use `corepack pnpm dev <command>` to run the CLI directly from TypeScript
sources without a global install. Bootstrap scripts:
`bash scripts/setup.sh` or `./scripts/setup.ps1`.

## Quality checks

Run the full local suite before opening a pull request:

```bash
corepack pnpm check
```

`check` runs the architecture/gateway guards, lint, tests with coverage, and the
build. Keep it green.

## Maintainer diagnostics

These commands are for source checkouts, not installed-package users:

- `talon release check` — end-to-end release gate
- `talon eval run`, `talon eval acceptance`, `talon eval compounding` — blind real-model capability evals
- `talon smoke run` — deterministic scripted smoke suite

Installed-package users should instead start with `talon doctor` and
`talon provider test`.

## Release validation

Run these checks before tagging or publishing a release:

```bash
corepack pnpm check
npm run release:check
npm pack --dry-run --json
```

The full suite can take several minutes. `release check` prints its current
stage and gives each child command a ten-minute timeout. If `corepack pnpm
check` has already passed in the same clean checkout, skip repeating lint,
tests, and build:

```bash
npm run release:check -- --skip-quality-checks
```

Publishing uses **npm Trusted Publishing (OIDC)** via
[`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml) — no
long-lived `NPM_TOKEN`. One-time setup on npmjs.com → package **Settings →
Trusted Publisher**:

- Repository: `XD319/auto-talon`
- Workflow filename: `publish-npm.yml` (filename only)
- Environment: `npm-publish` (must match the workflow `environment:`)

After tagging `v<version>` and pushing, publish from GitHub Actions:

```bash
gh workflow run publish-npm.yml -f version=<version>
gh run watch
```

Then validate the registry install:

```bash
npm install -g auto-talon@<version>
talon --version
talon doctor
```

After installing or updating a local project:

```bash
talon doctor
talon provider test
```

The release checklist covers lint, tests, build, smoke/eval threshold, beta
readiness, schema baseline, Node version policy, npm metadata, lockfile policy,
setup scripts, and package contents.

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hasLegacyShortRemoteTimeout, type ResolvedProviderConfig } from "../../providers/index.js";
import { listConfiguredApiSearchBackends } from "../../core/web-search-config.js";
import type { WebRuntimeConfig } from "../../core/web-search-config.js";
import { configureSqliteConnection } from "../../storage/sqlite-connection.js";
import { collectHttpAuthDoctorIssues } from "../../core/http-auth.js";
import { formatRipgrepMissingDoctorIssue } from "../../core/ripgrep.js";
import type { ExperienceRecord, ProviderHealthCheck } from "../../types/index.js";
import type { ShellBackend, WorkflowCustomShell, WorkflowTestCommand } from "../runtime-config.js";
import { resolveDefaultShellConfig } from "../../tools/shell/shell-executor.js";
import { resolveRuntimeConfig } from "../runtime-config.js";

export interface RuntimeDoctorServiceDependencies {
  allowedFetchHosts: string[];
  customShell: WorkflowCustomShell | null;
  databasePath: string;
  listExperiences: () => ExperienceRecord[];
  maxShellTimeoutMs: number;
  providerConfig: ResolvedProviderConfig;
  providerName: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  runtimeVersion: string;
  shellBackend: ShellBackend;
  skillStats: () => {
    issues: unknown[];
    skills: unknown[];
  };
  testCurrentProvider: (signal?: AbortSignal) => Promise<ProviderHealthCheck>;
  testCommands: WorkflowTestCommand[];
  tokenBudget: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
  };
  deprecatedCompactBufferTokens: number;
  workspaceRoot: string;
}

export class RuntimeDoctorService {
  public constructor(private readonly dependencies: RuntimeDoctorServiceDependencies) {}

  public async configDoctor(signal?: AbortSignal) {
    const providerHealth = await this.dependencies.testCurrentProvider(signal);
    const issues = collectDoctorIssues(this.dependencies.providerConfig, providerHealth);
    const experiences = this.dependencies.listExperiences();
    const skills = this.dependencies.skillStats();
    const configFiles = checkWorkspaceConfigFiles(this.dependencies.workspaceRoot);
    const workspaceSecretFindings = scanWorkspaceConfigSecrets(this.dependencies.workspaceRoot);
    const databaseReachable = canOpenDatabase(this.dependencies.databasePath);
    const schemaVersion = readSchemaVersion(this.dependencies.databasePath);
    const distFresh = checkDistFreshness(this.dependencies.workspaceRoot);
    const corepackAvailable = isCommandAvailable("corepack");
    const pnpmVersion = resolveCommandVersion("pnpm");
    const shellConfig = resolveDoctorShellConfig(this.dependencies.shellBackend, this.dependencies.customShell);
    const shellBackendAvailable = isShellBackendAvailable(this.dependencies.shellBackend, shellConfig.executable);
    const shellIssues =
      this.dependencies.shellBackend === "default" || shellBackendAvailable
        ? []
        : [`Shell backend ${this.dependencies.shellBackend} is not available at ${shellConfig.executable}.`];
    const testTimeoutIssues = collectTestTimeoutIssues(
      this.dependencies.testCommands,
      this.dependencies.maxShellTimeoutMs
    );
    const resolvedWeb = resolveRuntimeConfig(this.dependencies.workspaceRoot).web;
    const webConfigIssues = [
      ...collectLegacyWebFileIssues(this.dependencies.workspaceRoot),
      ...collectResolvedWebConfigIssues(resolvedWeb)
    ];
    const platformIssues = collectPlatformToolIssues();
    const httpAuthIssues = collectHttpAuthDoctorIssues(this.dependencies.workspaceRoot);
    const deprecatedConfigIssues = collectDeprecatedConfigIssues(
      this.dependencies.deprecatedCompactBufferTokens
    );

    return {
      apiKeyConfigured: providerHealth.apiKeyConfigured,
      allowedFetchHosts: this.dependencies.allowedFetchHosts,
      configPath: this.dependencies.providerConfig.configPath,
      configSource: this.dependencies.providerConfig.configSource,
      databasePath: this.dependencies.databasePath,
      endpointReachable: providerHealth.endpointReachable,
      experienceStats: {
        accepted: experiences.filter((experience) => experience.status === "accepted").length,
        candidate: experiences.filter((experience) => experience.status === "candidate").length,
        promoted: experiences.filter((experience) => experience.status === "promoted").length,
        rejected: experiences.filter((experience) => experience.status === "rejected").length,
        stale: experiences.filter((experience) => experience.status === "stale").length,
        total: experiences.length
      },
      issues: [
        ...issues,
        ...workspaceSecretFindings.map(
          (finding) =>
            `Workspace config ${finding.file} contains provider secret fields (${finding.fields.join(", ")}). Move secrets to env or user config.`
        ),
        ...shellIssues,
        ...testTimeoutIssues,
        ...webConfigIssues,
        ...platformIssues,
        ...httpAuthIssues,
        ...deprecatedConfigIssues
      ],
      maxRetries: this.dependencies.providerConfig.maxRetries,
      modelAvailable: providerHealth.modelAvailable,
      modelConfigured: providerHealth.modelConfigured,
      modelName: providerHealth.modelName,
      nodeVersion: process.version,
      pnpmVersion,
      corepackAvailable,
      providerHealthMessage: providerHealth.message,
      providerName: this.dependencies.providerName,
      runtimeConfigPath: this.dependencies.runtimeConfigPath,
      runtimeConfigSource: this.dependencies.runtimeConfigSource,
      runtimeVersion: this.dependencies.runtimeVersion,
      configFiles,
      workspaceSecretFindings,
      databaseReachable,
      distFresh,
      schemaVersion,
      shell: process.env.ComSpec,
      shellBackend: this.dependencies.shellBackend,
      shellBackendAvailable,
      shellExecutable: shellConfig.executable,
      shellMaxTimeoutMs: this.dependencies.maxShellTimeoutMs,
      skillStats: {
        enabled: skills.skills.length,
        issues: skills.issues.length,
        total: skills.skills.length + skills.issues.length
      },
      tokenBudget: this.dependencies.tokenBudget,
      timeoutMs: this.dependencies.providerConfig.timeoutMs,
      streamIdleTimeoutMs: this.dependencies.providerConfig.streamIdleTimeoutMs,
      workspaceRoot: this.dependencies.workspaceRoot
    };
  }
}

function collectDeprecatedConfigIssues(deprecatedCompactBufferTokens: number): string[] {
  if (deprecatedCompactBufferTokens <= 0) {
    return [];
  }
  return [
    `compact.bufferTokens is deprecated and has no runtime effect (configured value: ${deprecatedCompactBufferTokens}). Remove it from runtime.config.json; use tokenBudget and compact.thresholdRatio instead.`
  ];
}

function collectLegacyWebFileIssues(workspaceRoot: string): string[] {
  const runtimeConfigPath = join(workspaceRoot, ".auto-talon", "runtime.config.json");
  if (!existsSync(runtimeConfigPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(runtimeConfigPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    if (record.web !== undefined) {
      return [];
    }
    const legacyWebSearch = record.webSearch;
    if (
      legacyWebSearch !== null &&
      typeof legacyWebSearch === "object" &&
      !Array.isArray(legacyWebSearch) &&
      (legacyWebSearch as Record<string, unknown>).backend === "disabled"
    ) {
      return [
        "Legacy webSearch.backend is disabled and no web config is present. Add web.searchBackend (for example firecrawl/tavily/exa/brave/searxng) to enable web_search, or keep web.searchBackend=disabled when only web_extract is intended."
      ];
    }
  } catch {
    return [];
  }
  return [];
}

function collectResolvedWebConfigIssues(web: WebRuntimeConfig): string[] {
  const issues: string[] = [];
  if (web.searchBackend === "ddgs") {
    issues.push(
      "web.searchBackend resolves to ddgs (best-effort). Results depend on public scrapers and may be empty when blocked; configure a paid search backend for reliable web_search."
    );
    if (listConfiguredApiSearchBackends(web).length > 0) {
      issues.push(
        "Detected API credentials for web search while web.searchBackend is ddgs. Set web.searchBackend to \"auto\" or a specific API provider to prefer them over built-in scraping."
      );
    }
  }
  return issues;
}

export function collectPlatformToolIssues(
  options: {
    isCommandAvailable?: (command: string) => boolean;
    platform?: NodeJS.Platform;
  } = {}
): string[] {
  const platform = options.platform ?? process.platform;
  const isAvailable = options.isCommandAvailable ?? isCommandAvailable;
  const issues: string[] = [];
  if (!isAvailable("rg")) {
    issues.push(formatRipgrepMissingDoctorIssue(platform));
  }
  if (platform === "win32") {
    if (!isAvailable("git")) {
      issues.push(
        "git is not on PATH. Workspace commands that rely on git status may fail; install with `winget install Git.Git` or from https://git-scm.com/download/win and ensure `git --version` works in your shell (see docs/user/windows-troubleshooting.md)."
      );
    }
  }
  return issues;
}

function scanWorkspaceConfigSecrets(
  workspaceRoot: string
): Array<{ file: string; fields: string[] }> {
  const providerConfigPath = join(workspaceRoot, ".auto-talon", "provider.config.json");
  if (!existsSync(providerConfigPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(providerConfigPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const fields = collectSecretFields(parsed, []);
    return fields.length === 0
      ? []
      : [
          {
            fields,
            file: "provider.config.json"
          }
        ];
  } catch {
    return [];
  }
}

function collectSecretFields(value: unknown, path: string[]): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const fields: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isSecretField(key, child)) {
      fields.push(nextPath.join("."));
      continue;
    }
    fields.push(...collectSecretFields(child, nextPath));
  }
  return fields;
}

function isSecretField(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  return /^(apiKey|api_key|token|secret|password)$/iu.test(key);
}

function collectDoctorIssues(
  providerConfig: ResolvedProviderConfig,
  providerHealth: ProviderHealthCheck
): string[] {
  const issues: string[] = [];

  if (!providerHealth.apiKeyConfigured && providerConfig.name !== "mock") {
    issues.push("API key is missing.");
  }

  if (!providerHealth.modelConfigured) {
    issues.push("Model is not configured.");
  }

  const credential = (providerConfig as { credential?: ResolvedProviderConfig["credential"] }).credential;
  if (
    providerConfig.name !== "mock" &&
    providerConfig.builtinProviderName !== "ollama" &&
    credential !== undefined &&
    credential.credentialCount > 0 &&
    credential.credentialStatus !== "available"
  ) {
    issues.push(
      `Provider credential pool has no available credentials (status=${credential.credentialStatus}).`
    );
  }

  if (providerHealth.endpointReachable === false) {
    issues.push("Provider endpoint is not reachable.");
  }

  if (providerHealth.modelAvailable === false) {
    issues.push(`Model ${providerHealth.modelName ?? "-"} is not available on the provider endpoint.`);
  }

  if (hasLegacyShortRemoteTimeout(providerConfig)) {
    issues.push(
      `Provider request timeout is explicitly ${providerConfig.timeoutMs}ms; remote tool turns may need talon provider setup ${providerConfig.name} --timeout-ms 120000.`
    );
  }

  if (
    providerConfig.name !== "mock" &&
    providerConfig.configured !== false &&
    providerConfig.contextWindowTokens === null
  ) {
    issues.push(
      `Provider ${providerConfig.name} has no contextWindowTokens configured. Set providers.${providerConfig.name}.contextWindowTokens or tokenBudget.inputLimit in runtime.config.json.`
    );
  }

  if (!isCommandAvailable("corepack")) {
    issues.push("corepack is not available.");
  }

  return issues;
}

function checkWorkspaceConfigFiles(
  workspaceRoot: string
): Array<{ exists: boolean; file: string; parseable: boolean }> {
  const files = [
    "provider.config.json",
    "runtime.config.json",
    "sandbox.config.json",
    "gateway.config.json",
    "feishu.config.json",
    "mcp.config.json",
    "mcp-server.config.json"
  ];

  return files.map((file) => {
    const path = join(workspaceRoot, ".auto-talon", file);
    if (!existsSync(path)) {
      return { exists: false, file, parseable: false };
    }
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content.length > 0) {
        JSON.parse(content);
      }
      return { exists: true, file, parseable: true };
    } catch {
      return { exists: true, file, parseable: false };
    }
  });
}

function canOpenDatabase(databasePath: string): boolean {
  if (databasePath === ":memory:") {
    return true;
  }
  try {
    const db = new DatabaseSync(databasePath);
    configureSqliteConnection(db);
    db.close();
    return true;
  } catch {
    return false;
  }
}

function readSchemaVersion(databasePath: string): number | null {
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    return null;
  }
  try {
    const db = new DatabaseSync(databasePath);
    configureSqliteConnection(db);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    db.close();
    return row.user_version ?? 0;
  } catch {
    return null;
  }
}

function checkDistFreshness(workspaceRoot: string): boolean | null {
  const cliSource = join(workspaceRoot, "src", "cli", "index.ts");
  const cliDist = join(workspaceRoot, "dist", "cli", "index.js");
  if (!existsSync(cliSource) || !existsSync(cliDist)) {
    return null;
  }
  return statSync(cliDist).mtimeMs >= statSync(cliSource).mtimeMs;
}

function isCommandAvailable(command: string): boolean {
  return (
    spawnSync(command, ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32"
    }).status === 0
  );
}

function resolveDoctorShellConfig(
  backend: ShellBackend,
  customShell: WorkflowCustomShell | null
): { args: string[]; executable: string } {
  if (backend === "docker-sh") {
    return { args: ["run", "--rm", "<image>", "/bin/sh", "-lc"], executable: "docker" };
  }
  if (backend === "custom") {
    return {
      args: customShell?.args ?? [],
      executable: customShell?.executable ?? "-"
    };
  }
  return resolveDefaultShellConfig(backend);
}

function collectTestTimeoutIssues(testCommands: WorkflowTestCommand[], maxShellTimeoutMs: number): string[] {
  return testCommands.flatMap((command) => {
    if (typeof command === "string" || command.timeoutMs === undefined || command.timeoutMs <= maxShellTimeoutMs) {
      return [];
    }
    return [
      `Configured test command ${command.name} timeout ${command.timeoutMs}ms exceeds workflow.maxShellTimeoutMs ${maxShellTimeoutMs}ms.`
    ];
  });
}

function isShellBackendAvailable(backend: ShellBackend, executable: string): boolean {
  if (backend === "default") {
    return true;
  }

  if (backend === "docker-sh") {
    return (
      spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
        encoding: "utf8",
        shell: false,
        timeout: 15_000
      }).status === 0
    );
  }

  if (backend === "custom") {
    return executable !== "-" && spawnSync(executable, ["--version"], { encoding: "utf8", shell: false }).status === 0;
  }

  if (backend === "cmd") {
    return (
      spawnSync(executable, ["/d", "/s", "/c", "ver"], {
        encoding: "utf8",
        shell: false
      }).status === 0
    );
  }

  if (backend === "powershell") {
    return (
      spawnSync(executable, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        encoding: "utf8",
        shell: false
      }).status === 0
    );
  }

  if (backend === "git-bash") {
    return spawnSync(executable, ["--version"], { encoding: "utf8", shell: false }).status === 0;
  }

  return (
    spawnSync(executable, ["--status"], {
      encoding: "utf8",
      shell: false
    }).status === 0
  );
}

function resolveCommandVersion(command: string): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split("\n")[0] ?? null;
}

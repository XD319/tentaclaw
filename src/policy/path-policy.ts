import { isAbsolute, relative, resolve } from "node:path";

import { AppError } from "../runtime/app-error.js";

export interface PathPolicyConfig {
  workspaceRoot: string;
  writeRoots?: string[];
}

export class PathPolicy {
  private readonly workspaceRoot: string;
  private readonly writeRoots: string[];

  public constructor(config: PathPolicyConfig) {
    this.workspaceRoot = resolve(config.workspaceRoot);
    this.writeRoots = (config.writeRoots ?? [this.workspaceRoot]).map((entry) =>
      resolve(entry)
    );
  }

  public resolvePath(candidatePath: string, cwd: string): string {
    const resolvedPath = resolve(cwd, candidatePath);

    if (!this.isWithinRoot(resolvedPath, this.workspaceRoot)) {
      throw new AppError({
        code: "policy_denied",
        message: `Path ${resolvedPath} is outside workspace root.`,
        details: {
          candidatePath,
          resolvedPath,
          workspaceRoot: this.workspaceRoot
        }
      });
    }

    return resolvedPath;
  }

  public resolveReadPath(candidatePath: string, cwd: string): string {
    return this.resolvePath(candidatePath, cwd);
  }

  public resolveWritePath(candidatePath: string, cwd: string): string {
    const resolvedPath = resolve(cwd, candidatePath);
    const allowed = this.writeRoots.some((root) => this.isWithinRoot(resolvedPath, root));

    if (!allowed) {
      throw new AppError({
        code: "policy_denied",
        message: `Write path ${resolvedPath} is not within the configured write roots.`,
        details: {
          candidatePath,
          resolvedPath,
          writeRoots: this.writeRoots
        }
      });
    }

    return resolvedPath;
  }

  private isWithinRoot(candidatePath: string, rootPath: string): boolean {
    const relativePath = relative(rootPath, candidatePath);
    return (
      relativePath.length === 0 ||
      (!relativePath.startsWith("..\\") &&
        !relativePath.startsWith("../") &&
        relativePath !== ".." &&
        !isAbsolute(relativePath))
    );
  }
}

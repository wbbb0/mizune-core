import { isAbsolute, relative, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";

export interface ShellCwdResolution {
  cwd: string;
  root: string | null;
}

export function resolveShellCwd(config: AppConfig, input: string | undefined): ShellCwdResolution {
  const defaultRoot = resolveShellRoot(config, config.shell.cwd.defaultRoot || config.localFiles.root);
  const requested = String(input ?? "").trim();
  const cwd = requested
    ? (isAbsolute(requested) ? resolve(requested) : resolve(defaultRoot, requested))
    : defaultRoot;

  if (config.shell.cwd.allowAbsoluteOutsideRoots && requested && isAbsolute(requested)) {
    return { cwd, root: null };
  }

  const allowedRoots = resolveAllowedRoots(config);
  const matchedRoot = allowedRoots.find((root) => isPathInsideRoot(cwd, root)) ?? null;
  if (!matchedRoot) {
    throw new Error(`shell cwd is outside allowed roots: ${cwd}`);
  }

  return { cwd, root: matchedRoot };
}

function resolveAllowedRoots(config: AppConfig): string[] {
  const configured = config.shell.cwd.allowedRoots.length > 0
    ? config.shell.cwd.allowedRoots
    : [config.shell.cwd.defaultRoot || config.localFiles.root];
  const roots = configured.map((item) => resolveShellRoot(config, item));
  return Array.from(new Set(roots));
}

function resolveShellRoot(config: AppConfig, value: string): string {
  const normalized = String(value ?? "").trim() || "data";
  if (normalized === "localFiles.root") {
    const localRoot = String(config.localFiles.root ?? "").trim() || "data";
    return resolve(!localRoot || localRoot === "data" ? config.dataDir : localRoot);
  }
  return resolve(!normalized || normalized === "data" ? config.dataDir : normalized);
}

function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

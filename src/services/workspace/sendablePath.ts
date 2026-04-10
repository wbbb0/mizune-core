import { basename, isAbsolute, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import type { WorkspaceService } from "./workspaceService.ts";

export interface ResolvedSendablePath {
  absolutePath: string;
  sourceName: string;
  sourcePath: string;
  pathMode: "absolute" | "workspace_relative";
  workspacePath: string | null;
}

export function resolveSendablePath(
  config: AppConfig,
  workspaceService: Pick<WorkspaceService, "resolvePath">,
  inputPath: string
): ResolvedSendablePath {
  const normalizedInput = String(inputPath ?? "").trim();
  if (!normalizedInput) {
    throw new Error("path is required");
  }

  if (config.shell.allowAnyCwd) {
    if (!isAbsolute(normalizedInput)) {
      throw new Error("path must be absolute when shell.allowAnyCwd=true");
    }
    const absolutePath = resolve(normalizedInput);
    return {
      absolutePath,
      sourceName: basename(absolutePath),
      sourcePath: absolutePath,
      pathMode: "absolute",
      workspacePath: null
    };
  }

  if (isAbsolute(normalizedInput)) {
    throw new Error("absolute path is not allowed when shell.allowAnyCwd=false; use a workspace-relative path");
  }

  const resolvedPath = workspaceService.resolvePath(normalizedInput);
  return {
    absolutePath: resolvedPath.absolutePath,
    sourceName: basename(resolvedPath.relativePath),
    sourcePath: resolvedPath.relativePath,
    pathMode: "workspace_relative",
    workspacePath: resolvedPath.relativePath
  };
}

export function inferSendableFileKind(pathLike: string): "image" | "animated_image" | "file" {
  const normalized = String(pathLike ?? "").trim().toLowerCase();
  if (normalized.endsWith(".gif") || normalized.endsWith(".apng")) {
    return "animated_image";
  }
  if (
    normalized.endsWith(".png")
    || normalized.endsWith(".jpg")
    || normalized.endsWith(".jpeg")
    || normalized.endsWith(".webp")
    || normalized.endsWith(".bmp")
    || normalized.endsWith(".svg")
  ) {
    return "image";
  }
  return "file";
}

export function contentTypeFromPath(pathLike: string): string {
  const normalized = String(pathLike ?? "").trim().toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".bmp")) return "image/bmp";
  if (normalized.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (normalized.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (normalized.endsWith(".json")) return "application/json; charset=utf-8";
  if (normalized.endsWith(".yml") || normalized.endsWith(".yaml")) return "application/yaml; charset=utf-8";
  return "application/octet-stream";
}

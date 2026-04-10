import { basename, isAbsolute, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import type { LocalFileService } from "./localFileService.ts";

export interface ResolvedSendablePath {
  absolutePath: string;
  sourceName: string;
  sourcePath: string;
  pathMode: "absolute" | "workspace_relative";
  chatFilePath: string | null;
}

export function resolveSendablePath(
  config: AppConfig,
  localFileService: Pick<LocalFileService, "resolvePath">,
  inputPath: string
): ResolvedSendablePath {
  const normalizedInput = String(inputPath ?? "").trim();
  if (!normalizedInput) {
    throw new Error("path is required");
  }

  const mode = config.localFileAccess.read.mode;
  if (mode === "disabled") {
    throw new Error("local file read is disabled");
  }

  if (!isAbsolute(normalizedInput)) {
    const resolvedPath = localFileService.resolvePath(normalizedInput);
    return {
      absolutePath: resolvedPath.absolutePath,
      sourceName: basename(resolvedPath.relativePath),
      sourcePath: resolvedPath.relativePath,
      pathMode: "workspace_relative",
      chatFilePath: resolvedPath.relativePath
    };
  }

  if (mode === "allowed_roots" && !isPathWithinAllowedRoots(config.localFileAccess.read.allowedRoots, normalizedInput)) {
    throw new Error(`path is outside allowed local file roots: ${normalizedInput}`);
  }

  const absolutePath = resolve(normalizedInput);
  return {
    absolutePath,
    sourceName: basename(absolutePath),
    sourcePath: absolutePath,
    pathMode: "absolute",
    chatFilePath: null
  };
}

function isPathWithinAllowedRoots(allowedRoots: string[], inputPath: string): boolean {
  const absolutePath = resolve(inputPath);
  return allowedRoots
    .map((root) => resolve(root))
    .some((root) => absolutePath === root || absolutePath.startsWith(`${root}/`));
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

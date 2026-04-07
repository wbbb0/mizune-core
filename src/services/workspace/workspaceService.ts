import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, posix, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import type {
  WorkspaceFileContentResult,
  WorkspaceDeleteResult,
  WorkspaceFileReadResult,
  WorkspaceItemStat,
  WorkspaceListResult,
  WorkspaceMoveResult,
  WorkspacePatchResult,
  WorkspaceWriteMode,
  WorkspaceWriteResult
} from "./types.ts";

const DEFAULT_READ_LINE_LIMIT = 400;

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export class WorkspaceService {
  readonly rootDir: string;

  constructor(private readonly config: AppConfig, dataDir: string) {
    const configuredRoot = String(config.workspace.root ?? "").trim();
    this.rootDir = resolve(!configuredRoot || configuredRoot === "data" ? dataDir : configuredRoot);
  }

  isEnabled(): boolean {
    return this.config.workspace.enabled;
  }

  async init(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    await mkdir(this.rootDir, { recursive: true });
  }

  resolvePath(relativePath = "."): { relativePath: string; absolutePath: string } {
    if (!this.isEnabled()) {
      throw new Error("Workspace is disabled");
    }
    const normalizedInput = String(relativePath ?? "").trim() || ".";
    if (normalizedInput.startsWith("/") || normalizedInput.startsWith("\\")) {
      throw new Error("Absolute paths are not allowed in workspace tools");
    }
    const normalizedRelative = posix.normalize(normalizedInput.replaceAll("\\", "/"));
    if (normalizedRelative === ".." || normalizedRelative.startsWith("../")) {
      throw new Error("Workspace path cannot escape the root directory");
    }
    const cleanedRelative = normalizedRelative === "." ? "" : normalizedRelative;
    const absolutePath = resolve(this.rootDir, cleanedRelative);
    const relativeFromRoot = normalize(absolutePath).startsWith(normalize(this.rootDir))
      ? cleanedRelative
      : null;
    if (relativeFromRoot == null) {
      throw new Error("Workspace path cannot escape the root directory");
    }
    return {
      relativePath: cleanedRelative || ".",
      absolutePath
    };
  }

  async listItems(relativePath = "."): Promise<WorkspaceListResult> {
    const target = this.resolvePath(relativePath);
    const entries = await readdir(target.absolutePath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const items = await Promise.all(entries.map(async (entry): Promise<WorkspaceItemStat> => {
      const itemRelativePath = target.relativePath === "."
        ? entry.name
        : posix.join(target.relativePath, entry.name);
      const itemAbsolutePath = join(target.absolutePath, entry.name);
      const itemStat = await stat(itemAbsolutePath);
      return {
        path: itemRelativePath,
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        sizeBytes: itemStat.size,
        updatedAtMs: itemStat.mtimeMs
      };
    }));
    return {
      root: this.rootDir,
      path: target.relativePath,
      items: items.sort((left, right) => left.path.localeCompare(right.path))
    };
  }

  async statItem(relativePath: string): Promise<WorkspaceItemStat> {
    const target = this.resolvePath(relativePath);
    const itemStat = await stat(target.absolutePath);
    return {
      path: target.relativePath,
      name: basenameFromRelative(target.relativePath),
      kind: itemStat.isDirectory() ? "directory" : "file",
      sizeBytes: itemStat.size,
      updatedAtMs: itemStat.mtimeMs
    };
  }

  async readFile(relativePath: string, options?: {
    startLine?: number;
    endLine?: number;
  }): Promise<WorkspaceFileReadResult> {
    const target = this.resolvePath(relativePath);
    const rawBuffer = await readFile(target.absolutePath);
    assertTextFile(rawBuffer, target.relativePath, this.config.workspace.maxPatchFileBytes);
    const raw = rawBuffer.toString("utf8");
    const lines = raw.split("\n");
    const startLine = Math.max(1, Math.floor(options?.startLine ?? 1));
    const requestedEndLine = options?.endLine == null
      ? startLine + DEFAULT_READ_LINE_LIMIT - 1
      : Math.max(startLine, Math.floor(options.endLine));
    const safeEndLine = Math.min(lines.length, requestedEndLine);
    const sliced = lines.slice(startLine - 1, safeEndLine);
    return {
      path: target.relativePath,
      content: sliced.join("\n"),
      startLine,
      endLine: safeEndLine,
      totalLines: lines.length,
      truncated: safeEndLine < lines.length
    };
  }

  async readFileContent(relativePath: string): Promise<WorkspaceFileContentResult> {
    const target = this.resolvePath(relativePath);
    const itemStat = await stat(target.absolutePath);
    if (itemStat.isDirectory()) {
      throw new Error(`Workspace path is not a file: ${target.relativePath}`);
    }
    return {
      path: target.relativePath,
      contentType: contentTypeFromPath(target.relativePath),
      buffer: await readFile(target.absolutePath)
    };
  }

  async writeFile(relativePath: string, content: string, mode: WorkspaceWriteMode): Promise<WorkspaceWriteResult> {
    const target = this.resolvePath(relativePath);
    await mkdir(dirname(target.absolutePath), { recursive: true });
    const normalizedContent = String(content ?? "");
    if (Buffer.byteLength(normalizedContent, "utf8") > this.config.workspace.maxPatchFileBytes) {
      throw new Error("Workspace file content exceeds maxPatchFileBytes");
    }
    if (mode === "create") {
      const existing = await stat(target.absolutePath).then(() => true).catch(() => false);
      if (existing) {
        throw new Error(`Workspace file already exists: ${target.relativePath}`);
      }
    }
    if (mode === "append") {
      const previous = await readFile(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return Buffer.alloc(0);
        }
        throw error;
      });
      assertTextFile(previous, target.relativePath, this.config.workspace.maxPatchFileBytes);
      await writeFile(target.absolutePath, `${previous.toString("utf8")}${normalizedContent}`, "utf8");
    } else {
      await writeFile(target.absolutePath, normalizedContent, "utf8");
    }
    const updated = await stat(target.absolutePath);
    return {
      path: target.relativePath,
      bytesWritten: Buffer.byteLength(normalizedContent, "utf8"),
      updatedAtMs: updated.mtimeMs
    };
  }

  async mkdir(relativePath: string): Promise<WorkspaceItemStat> {
    const target = this.resolvePath(relativePath);
    await mkdir(target.absolutePath, { recursive: true });
    return this.statItem(target.relativePath);
  }

  async moveItem(fromPath: string, toPath: string): Promise<WorkspaceMoveResult> {
    const from = this.resolvePath(fromPath);
    const to = this.resolvePath(toPath);
    await mkdir(dirname(to.absolutePath), { recursive: true });
    await rename(from.absolutePath, to.absolutePath);
    return {
      fromPath: from.relativePath,
      toPath: to.relativePath
    };
  }

  async deleteItem(relativePath: string): Promise<WorkspaceDeleteResult> {
    const target = this.resolvePath(relativePath);
    const existed = await stat(target.absolutePath).then(() => true).catch(() => false);
    await rm(target.absolutePath, { recursive: true, force: true });
    return {
      path: target.relativePath,
      deleted: existed
    };
  }

  async patchFile(relativePath: string, patch: string): Promise<WorkspacePatchResult> {
    const target = this.resolvePath(relativePath);
    const originalBuffer = await readFile(target.absolutePath);
    assertTextFile(originalBuffer, target.relativePath, this.config.workspace.maxPatchFileBytes);
    const original = originalBuffer.toString("utf8");
    const patched = applyUnifiedPatch(original, patch);
    await writeFile(target.absolutePath, patched, "utf8");
    const updated = await stat(target.absolutePath);
    return {
      path: target.relativePath,
      updatedAtMs: updated.mtimeMs,
      hunksApplied: countPatchHunks(patch)
    };
  }
}

function basenameFromRelative(relativePath: string): string {
  if (relativePath === ".") {
    return ".";
  }
  const parts = relativePath.split("/");
  return parts[parts.length - 1] ?? relativePath;
}

function assertTextFile(content: Buffer, relativePath: string, maxBytes: number): void {
  if (content.byteLength > maxBytes) {
    throw new Error(`Workspace file is too large for text operations: ${relativePath}`);
  }
  if (content.includes(0)) {
    throw new Error(`Workspace file is not a text file: ${relativePath}`);
  }
}

function contentTypeFromPath(relativePath: string): string {
  const normalized = relativePath.toLowerCase();
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

function countPatchHunks(patch: string): number {
  return patch.split("\n").filter((line) => line.startsWith("@@")).length;
}

function applyUnifiedPatch(original: string, patch: string): string {
  const originalLines = original.split("\n");
  const hunks = parseUnifiedPatch(patch);
  let cursor = 0;
  const nextLines: string[] = [];

  for (const hunk of hunks) {
    const hunkStart = Math.max(0, hunk.oldStart - 1);
    if (hunkStart < cursor) {
      throw new Error("Workspace patch hunks overlap or are out of order");
    }
    nextLines.push(...originalLines.slice(cursor, hunkStart));
    let localCursor = hunkStart;

    for (const line of hunk.lines) {
      const marker = line[0] ?? "";
      const content = line.slice(1);
      if (marker === " ") {
        if (originalLines[localCursor] !== content) {
          throw new Error(`Workspace patch context mismatch near line ${localCursor + 1}`);
        }
        nextLines.push(content);
        localCursor += 1;
        continue;
      }
      if (marker === "-") {
        if (originalLines[localCursor] !== content) {
          throw new Error(`Workspace patch delete mismatch near line ${localCursor + 1}`);
        }
        localCursor += 1;
        continue;
      }
      if (marker === "+") {
        nextLines.push(content);
        continue;
      }
      if (marker === "\\") {
        continue;
      }
      throw new Error(`Unsupported workspace patch line: ${line}`);
    }

    cursor = localCursor;
  }

  nextLines.push(...originalLines.slice(cursor));
  return nextLines.join("\n");
}

function parseUnifiedPatch(patch: string): ParsedHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: ParsedHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("@@")) {
      index += 1;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      throw new Error(`Invalid workspace patch header: ${line}`);
    }
    index += 1;
    const hunkLines: string[] = [];
    while (index < lines.length && !lines[index]?.startsWith("@@")) {
      hunkLines.push(lines[index] ?? "");
      index += 1;
    }
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
      lines: hunkLines
    });
  }
  if (hunks.length === 0) {
    throw new Error("Workspace patch must contain at least one hunk");
  }
  return hunks;
}

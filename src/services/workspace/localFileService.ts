import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import type {
  LocalFileContentResult,
  LocalFileDeleteResult,
  LocalFileFindTextResult,
  LocalFileItemStat,
  LocalFileListResult,
  LocalFileMoveResult,
  LocalFilePatchResult,
  LocalFileReadResult,
  LocalFileSearchItem,
  LocalFileSearchResult,
  LocalFileWriteMode,
  LocalFileWriteResult
} from "./types.ts";

const DEFAULT_READ_LINE_LIMIT = 400;

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export class LocalFileService {
  readonly rootDir: string;

  constructor(private readonly config: AppConfig, dataDir: string) {
    const configuredRoot = String(config.localFiles.root ?? "").trim();
    this.rootDir = resolve(!configuredRoot || configuredRoot === "data" ? dataDir : configuredRoot);
  }

  isEnabled(): boolean {
    return this.config.localFiles.enabled;
  }

  async init(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    await mkdir(this.rootDir, { recursive: true });
  }

  resolvePath(inputPath = "."): { relativePath: string; absolutePath: string } {
    if (!this.isEnabled()) {
      throw new Error("local files are disabled");
    }
    const normalizedInput = String(inputPath ?? "").trim() || ".";

    if (isAbsolute(normalizedInput)) {
      const absolutePath = resolve(normalizedInput);
      return {
        relativePath: absolutePath,
        absolutePath
      };
    }

    const normalizedRelative = posix.normalize(normalizedInput.replaceAll("\\", "/"));
    if (normalizedRelative === ".." || normalizedRelative.startsWith("../")) {
      throw new Error("local file path cannot escape the root directory");
    }
    const cleanedRelative = normalizedRelative === "." ? "" : normalizedRelative;
    const absolutePath = resolve(this.rootDir, cleanedRelative);
    const relativeFromRoot = normalize(absolutePath).startsWith(normalize(this.rootDir))
      ? cleanedRelative
      : null;
    if (relativeFromRoot == null) {
      throw new Error("local file path cannot escape the root directory");
    }
    return {
      relativePath: cleanedRelative || ".",
      absolutePath
    };
  }

  async listItems(relativePath = ".", limit = 200): Promise<LocalFileListResult> {
    const target = this.resolvePath(relativePath);
    const entries = await readdir(target.absolutePath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const items = await Promise.all(entries.map(async (entry): Promise<LocalFileItemStat> => {
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
    const sorted = items.sort((left, right) => left.path.localeCompare(right.path));
    const truncated = sorted.length > limit;
    return {
      root: this.rootDir,
      path: target.relativePath,
      items: truncated ? sorted.slice(0, limit) : sorted,
      truncated
    };
  }

  async statItem(relativePath: string): Promise<LocalFileItemStat> {
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
  }): Promise<LocalFileReadResult> {
    const target = this.resolvePath(relativePath);
    const rawBuffer = await readFile(target.absolutePath);
    assertTextFile(rawBuffer, target.relativePath, this.config.localFiles.maxPatchFileBytes);
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

  async readFileContent(relativePath: string): Promise<LocalFileContentResult> {
    const target = this.resolvePath(relativePath);
    const itemStat = await stat(target.absolutePath);
    if (itemStat.isDirectory()) {
      throw new Error(`local file path is not a file: ${target.relativePath}`);
    }
    return {
      path: target.relativePath,
      contentType: contentTypeFromPath(target.relativePath),
      buffer: await readFile(target.absolutePath)
    };
  }

  async writeFile(relativePath: string, content: string, mode: LocalFileWriteMode): Promise<LocalFileWriteResult> {
    const target = this.resolvePath(relativePath);
    await mkdir(dirname(target.absolutePath), { recursive: true });
    const normalizedContent = String(content ?? "");
    if (Buffer.byteLength(normalizedContent, "utf8") > this.config.localFiles.maxPatchFileBytes) {
      throw new Error("local file content exceeds maxPatchFileBytes");
    }
    if (mode === "create") {
      const existing = await stat(target.absolutePath).then(() => true).catch(() => false);
      if (existing) {
        throw new Error(`local file already exists: ${target.relativePath}`);
      }
    }
    if (mode === "append") {
      const previous = await readFile(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return Buffer.alloc(0);
        }
        throw error;
      });
      assertTextFile(previous, target.relativePath, this.config.localFiles.maxPatchFileBytes);
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

  async mkdir(relativePath: string): Promise<LocalFileItemStat> {
    const target = this.resolvePath(relativePath);
    await mkdir(target.absolutePath, { recursive: true });
    return this.statItem(target.relativePath);
  }

  async moveItem(fromPath: string, toPath: string): Promise<LocalFileMoveResult> {
    const from = this.resolvePath(fromPath);
    const to = this.resolvePath(toPath);
    await mkdir(dirname(to.absolutePath), { recursive: true });
    await rename(from.absolutePath, to.absolutePath);
    return {
      fromPath: from.relativePath,
      toPath: to.relativePath
    };
  }

  async deleteItem(relativePath: string): Promise<LocalFileDeleteResult> {
    const target = this.resolvePath(relativePath);
    const existed = await stat(target.absolutePath).then(() => true).catch(() => false);
    await rm(target.absolutePath, { recursive: true, force: true });
    return {
      path: target.relativePath,
      deleted: existed
    };
  }

  async patchFile(relativePath: string, patch: string): Promise<LocalFilePatchResult> {
    const target = this.resolvePath(relativePath);
    const originalBuffer = await readFile(target.absolutePath);
    assertTextFile(originalBuffer, target.relativePath, this.config.localFiles.maxPatchFileBytes);
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

  async searchItems(query: string, relativePath = ".", limit = 50): Promise<LocalFileSearchResult> {
    const normalizedQuery = String(query ?? "").trim().toLowerCase();
    if (!normalizedQuery) {
      throw new Error("query is required");
    }
    const target = this.resolvePath(relativePath);
    const items: LocalFileSearchItem[] = [];
    let truncated = false;
    await this.walk(target.relativePath, async (itemPath, entryKind) => {
      if (items.length >= limit) {
        truncated = true;
        return false;
      }
      const name = basenameFromRelative(itemPath).toLowerCase();
      if (name.includes(normalizedQuery) || itemPath.toLowerCase().includes(normalizedQuery)) {
        items.push({
          path: itemPath,
          name: basenameFromRelative(itemPath),
          kind: entryKind
        });
      }
      return true;
    });
    return {
      root: this.rootDir,
      path: target.relativePath,
      query: normalizedQuery,
      items,
      truncated
    };
  }

  async findText(query: string, relativePath = ".", limit = 50): Promise<LocalFileFindTextResult> {
    const normalizedQuery = String(query ?? "").trim();
    if (!normalizedQuery) {
      throw new Error("query is required");
    }
    const target = this.resolvePath(relativePath);
    const matches: LocalFileFindTextResult["matches"] = [];
    let truncated = false;
    await this.walk(target.relativePath, async (itemPath, entryKind) => {
      if (entryKind !== "file") {
        return true;
      }
      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
      const absolutePath = this.resolvePath(itemPath).absolutePath;
      const buffer = await readFile(absolutePath).catch(() => null);
      if (!buffer) {
        return true;
      }
      try {
        assertTextFile(buffer, itemPath, this.config.localFiles.maxPatchFileBytes);
      } catch {
        return true;
      }
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= limit) {
          truncated = true;
          return false;
        }
        const lineText = lines[index] ?? "";
        if (lineText.includes(normalizedQuery)) {
          matches.push({
            path: itemPath,
            line: index + 1,
            text: lineText
          });
        }
      }
      return true;
    });
    return {
      root: this.rootDir,
      path: target.relativePath,
      query: normalizedQuery,
      matches,
      truncated
    };
  }

  private async walk(
    relativePath: string,
    visitor: (itemPath: string, kind: "file" | "directory") => Promise<boolean>
  ): Promise<boolean> {
    const target = this.resolvePath(relativePath);
    const entries = await readdir(target.absolutePath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });

    for (const entry of entries) {
      const itemPath = target.relativePath === "." ? entry.name : posix.join(target.relativePath, entry.name);
      const kind = entry.isDirectory() ? "directory" as const : "file" as const;
      const shouldContinue = await visitor(itemPath, kind);
      if (!shouldContinue) {
        return false;
      }
      if (entry.isDirectory()) {
        const nestedContinue = await this.walk(itemPath, visitor);
        if (!nestedContinue) {
          return false;
        }
      }
    }
    return true;
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

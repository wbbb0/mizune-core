import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ChatFileRecord = {
  fileId: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  origin: string;
  chatFilePath: string;
  sourceName: string | null;
  mimeType: string | null;
  sourceContext?: Record<string, unknown>;
};

type ChatAttachment = {
  fileId: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  source: "chat_message" | "web_upload" | "browser" | "chat_file";
  sourceName: string | null;
  mimeType: string | null;
  semanticKind?: "image" | "emoji";
};

type CleanupStats = {
  sessionsScanned: number;
  sessionsChanged: number;
  pendingRemoved: number;
  pendingReplaced: number;
  duplicateAttachmentsRemoved: number;
  unreferencedFilesDeleted: number;
  unreferencedFilesWouldDelete: number;
};

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const deleteUnreferenced = args.has("--delete-unreferenced-chat-message-files");
const dataDirArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const dataDir = resolve(dataDirArg ?? process.env.DATA_DIR ?? "data");

const stats: CleanupStats = {
  sessionsScanned: 0,
  sessionsChanged: 0,
  pendingRemoved: 0,
  pendingReplaced: 0,
  duplicateAttachmentsRemoved: 0,
  unreferencedFilesDeleted: 0,
  unreferencedFilesWouldDelete: 0
};

const instanceDirs = await listDirectories(dataDir);
for (const instanceDir of instanceDirs) {
  await cleanupInstance(instanceDir);
}

console.log(JSON.stringify({
  dataDir,
  apply,
  deleteUnreferenced,
  ...stats
}, null, 2));

async function cleanupInstance(instanceDir: string): Promise<void> {
  const chatFilesPath = resolve(instanceDir, "chat-files", "files.json");
  const sessionsDir = resolve(instanceDir, "sessions");
  const chatFiles = await readJsonFile<ChatFileRecord[]>(chatFilesPath).catch(() => []);
  const fileBySource = new Map<string, ChatFileRecord>();
  for (const file of chatFiles) {
    const source = String(file.sourceContext?.source ?? "").trim();
    if (source) {
      fileBySource.set(source, file);
    }
  }

  const sessionFiles = await listJsonFiles(sessionsDir);
  const cleanedSessions: unknown[] = [];
  for (const sessionPath of sessionFiles) {
    const session = await readJsonFile<Record<string, unknown>>(sessionPath);
    stats.sessionsScanned += 1;
    const before = JSON.stringify(session);
    cleanMessageList(session.pendingMessages, fileBySource);
    cleanTranscript(session.internalTranscript, fileBySource);
    if (JSON.stringify(session) !== before) {
      stats.sessionsChanged += 1;
      if (apply) {
        await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
      }
    }
    cleanedSessions.push(session);
  }

  if (!deleteUnreferenced) {
    return;
  }
  const referencedFileIds = collectReferencedFileIds(cleanedSessions);
  const retainedFiles: ChatFileRecord[] = [];
  let fileIndexChanged = false;
  for (const file of chatFiles) {
    if (file.origin === "chat_message" && !referencedFileIds.has(file.fileId)) {
      stats.unreferencedFilesWouldDelete += 1;
      fileIndexChanged = true;
      if (apply) {
        await rm(resolve(instanceDir, file.chatFilePath), { force: true });
        stats.unreferencedFilesDeleted += 1;
      }
      continue;
    }
    retainedFiles.push(file);
  }
  if (apply && fileIndexChanged) {
    await writeFile(chatFilesPath, `${JSON.stringify(retainedFiles, null, 2)}\n`, "utf8");
  }
}

function cleanTranscript(value: unknown, fileBySource: Map<string, ChatFileRecord>): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (!isRecord(item) || item.kind !== "user_message") {
      continue;
    }
    cleanMediaIds(item, "imageIds");
    cleanMediaIds(item, "emojiIds");
    item.attachments = cleanAttachments(item.attachments, fileBySource);
  }
}

function cleanMessageList(value: unknown, fileBySource: Map<string, ChatFileRecord>): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    cleanMediaIds(item, "imageIds");
    cleanMediaIds(item, "emojiIds");
    item.attachments = cleanAttachments(item.attachments, fileBySource);
  }
}

function cleanMediaIds(target: Record<string, unknown>, key: "imageIds" | "emojiIds"): void {
  if (!Array.isArray(target[key])) {
    target[key] = [];
    return;
  }
  const seen = new Set<string>();
  target[key] = target[key].flatMap((value) => {
    const fileId = String(value ?? "").trim();
    if (!fileId || fileId.startsWith("pending:") || seen.has(fileId)) {
      return [];
    }
    seen.add(fileId);
    return [fileId];
  });
}

function cleanAttachments(value: unknown, fileBySource: Map<string, ChatFileRecord>): ChatAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const cleaned: ChatAttachment[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) {
      continue;
    }
    const fileId = String(raw.fileId ?? "").trim();
    if (!fileId) {
      continue;
    }
    const replacement = fileId.startsWith("pending:")
      ? resolvePendingAttachment(fileId, fileBySource)
      : toAttachment(raw);
    if (fileId.startsWith("pending:")) {
      stats.pendingRemoved += 1;
      if (replacement) {
        stats.pendingReplaced += 1;
      }
    }
    if (!replacement) {
      continue;
    }
    if (seen.has(replacement.fileId)) {
      stats.duplicateAttachmentsRemoved += 1;
      continue;
    }
    seen.add(replacement.fileId);
    cleaned.push(replacement);
  }
  return cleaned;
}

function resolvePendingAttachment(fileId: string, fileBySource: Map<string, ChatFileRecord>): ChatAttachment | null {
  const match = fileId.match(/^pending:(?:image|file):\d+:(.+)$/);
  const source = match?.[1]?.trim();
  if (!source) {
    return null;
  }
  const file = fileBySource.get(source);
  return file ? attachmentFromFile(file) : null;
}

function attachmentFromFile(file: ChatFileRecord): ChatAttachment {
  return {
    fileId: file.fileId,
    kind: file.kind,
    source: file.origin === "chat_message" ? "chat_message" : "chat_file",
    sourceName: file.sourceName ?? null,
    mimeType: file.mimeType ?? null,
    ...(file.sourceContext?.mediaKind === "emoji" ? { semanticKind: "emoji" as const } : {}),
    ...(file.sourceContext?.mediaKind === "image" ? { semanticKind: "image" as const } : {})
  };
}

function toAttachment(raw: Record<string, unknown>): ChatAttachment | null {
  const fileId = String(raw.fileId ?? "").trim();
  if (!fileId || fileId.startsWith("pending:")) {
    return null;
  }
  const kind = String(raw.kind ?? "");
  if (!["image", "animated_image", "video", "audio", "file"].includes(kind)) {
    return null;
  }
  const source = String(raw.source ?? "chat_message");
  return {
    fileId,
    kind: kind as ChatAttachment["kind"],
    source: ["chat_message", "web_upload", "browser", "chat_file"].includes(source)
      ? source as ChatAttachment["source"]
      : "chat_message",
    sourceName: raw.sourceName == null ? null : String(raw.sourceName),
    mimeType: raw.mimeType == null ? null : String(raw.mimeType),
    ...(raw.semanticKind === "emoji" ? { semanticKind: "emoji" as const } : {}),
    ...(raw.semanticKind === "image" ? { semanticKind: "image" as const } : {})
  };
}

function collectReferencedFileIds(sessions: unknown[]): Set<string> {
  const fileIds = new Set<string>();
  for (const session of sessions) {
    if (!isRecord(session)) {
      continue;
    }
    collectFromMessageList(fileIds, session.pendingMessages);
    collectFromTranscript(fileIds, session.internalTranscript);
  }
  return fileIds;
}

function collectFromTranscript(fileIds: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.kind === "user_message") {
      collectFromMessage(fileIds, item);
      continue;
    }
    const fileId = String(item.kind === "outbound_media_message" ? item.fileId ?? "" : "").trim();
    if (fileId && !fileId.startsWith("pending:")) {
      fileIds.add(fileId);
    }
  }
}

function collectFromMessageList(fileIds: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (isRecord(item)) {
      collectFromMessage(fileIds, item);
    }
  }
}

function collectFromMessage(fileIds: Set<string>, item: Record<string, unknown>): void {
  for (const key of ["imageIds", "emojiIds"] as const) {
    const values = item[key];
    if (Array.isArray(values)) {
      for (const value of values) {
        const fileId = String(value ?? "").trim();
        if (fileId && !fileId.startsWith("pending:")) {
          fileIds.add(fileId);
        }
      }
    }
  }
  if (Array.isArray(item.attachments)) {
    for (const attachment of item.attachments) {
      if (!isRecord(attachment)) {
        continue;
      }
      const fileId = String(attachment.fileId ?? "").trim();
      if (fileId && !fileId.startsWith("pending:")) {
        fileIds.add(fileId);
      }
    }
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function listDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(path, entry);
    if ((await stat(fullPath).catch(() => null))?.isDirectory()) {
      dirs.push(fullPath);
    }
  }
  return dirs;
}

async function listJsonFiles(path: string): Promise<string[]> {
  const entries = await readdir(path).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => resolve(path, entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

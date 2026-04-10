import type { Logger } from "pino";
import type {
  PersistedSessionState,
  InternalTranscriptItem,
  PersistedSessionMessage,
  SessionMessage,
  SessionState,
  TranscriptUserMessageItem
} from "#conversation/session/sessionTypes.ts";
import type { ChatFileStore } from "./chatFileStore.ts";

export class ChatMessageFileGcService {
  constructor(
    private readonly chatFileStore: Pick<ChatFileStore, "listFiles" | "deleteFile">,
    private readonly logger: Logger,
    private readonly gcGracePeriodMs: number
  ) {}

  async sweep(input: {
    activeSessions: SessionState[];
    persistedSessions: PersistedSessionState[];
    now?: number;
  }): Promise<{ deletedFileIds: string[] }> {
    const now = input.now ?? Date.now();
    const referencedFileIds = collectReferencedFileIds(input.activeSessions, input.persistedSessions);
    const files = await this.chatFileStore.listFiles();
    const deletable = files.filter((file) => (
      file.origin === "chat_message"
      && !referencedFileIds.has(file.fileId)
      && now - file.createdAtMs >= this.gcGracePeriodMs
    ));
    const deletedFileIds: string[] = [];
    for (const file of deletable) {
      const deleted = await this.chatFileStore.deleteFile(file.fileId).catch(() => false);
      if (deleted) {
        deletedFileIds.push(file.fileId);
      }
    }
    if (deletedFileIds.length > 0) {
      this.logger.info({ deletedFileIds }, "chat_message_file_gc_deleted");
    }
    return { deletedFileIds };
  }
}

function collectReferencedFileIds(activeSessions: SessionState[], persistedSessions: PersistedSessionState[]): Set<string> {
  const fileIds = new Set<string>();
  for (const session of activeSessions) {
    for (const message of session.pendingMessages) {
      collectFromMessage(fileIds, message);
    }
    for (const item of session.internalTranscript) {
      collectFromTranscriptItem(fileIds, item);
    }
  }
  for (const session of persistedSessions) {
    for (const message of session.pendingMessages) {
      collectFromMessage(fileIds, message);
    }
    for (const item of session.internalTranscript) {
      collectFromTranscriptItem(fileIds, item);
    }
  }
  return fileIds;
}

function collectFromMessage(fileIds: Set<string>, message: PersistedSessionMessage | SessionMessage): void {
  for (const fileId of [...message.imageIds, ...message.emojiIds]) {
    if (fileId) {
      fileIds.add(fileId);
    }
  }
  for (const attachment of message.attachments ?? []) {
    if (attachment.fileId) {
      fileIds.add(attachment.fileId);
    }
  }
}

function collectFromTranscriptItem(fileIds: Set<string>, item: InternalTranscriptItem): void {
  if (item.kind === "user_message") {
    collectFromTranscriptUserMessage(fileIds, item);
    return;
  }
  if (item.kind === "outbound_media_message" && item.fileId) {
    fileIds.add(item.fileId);
  }
}

function collectFromTranscriptUserMessage(fileIds: Set<string>, item: TranscriptUserMessageItem): void {
  for (const fileId of [...item.imageIds, ...item.emojiIds]) {
    if (fileId) {
      fileIds.add(fileId);
    }
  }
  for (const attachment of item.attachments ?? []) {
    if (attachment.fileId) {
      fileIds.add(attachment.fileId);
    }
  }
}

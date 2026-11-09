import { createHash } from "node:crypto";
import { MediaImportService } from "../../src/services/workspace/mediaSources/service.ts";
import type { MediaSourceRecord, MediaSourceRepository } from "../../src/services/workspace/mediaSources/types.ts";
import type { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import type { MessageContentPart } from "../../src/messages/contentParts.ts";
import type { MediaScope } from "../../src/services/workspace/mediaSources/types.ts";
import type { OneBotReferenceResolver } from "../../src/services/onebot/referenceResolver.ts";
import { OneBotReferenceResolver as NativeReferenceResolver } from "../../src/services/onebot/referenceResolver.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "./config-fixtures.tsx";
import { parseChatSessionIdentity } from "../../src/conversation/session/sessionIdentity.ts";

export function createMemoryMediaSources(): MediaSourceRepository {
  const records = new Map<string, MediaSourceRecord>();
  return {
    async register(scope, input, signal) {
      signal?.throwIfAborted();
      const key = createHash("sha256").update(JSON.stringify([scope, input.kind, input.locator ?? input.source])).digest("hex");
      const id = `media_${key.slice(0, 32)}`;
      const record = records.get(id) ?? { ...scope, id, key, input, assetId: null, failures: 0, nextRetryAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, version: 1 };
      if (record.input.source !== input.source) { record.failures = 0; record.nextRetryAt = 0; record.version++; }
      record.input = input;
      records.set(id, record);
      return structuredClone(record);
    },
    async get(scope, id) {
      const row = records.get(id);
      return row && row.sessionId === scope.sessionId && row.connectionId === scope.connectionId ? structuredClone(row) : null;
    },
    async save(record, signal) { signal?.throwIfAborted(); const previous = records.get(record.id); if (!previous || previous.version !== record.version) return false; record.version++; records.set(record.id, structuredClone(record)); return true; }
  };
}

export function createTestMediaImportService(files: Partial<Pick<ChatFileStore, "importRemoteSource" | "getFile" | "isFileAvailable" | "deleteFile">> = {}) {
  return new MediaImportService({ sources: createMemoryMediaSources(), refresh: async () => null,
    files: { deleteFile: files.deleteFile?.bind(files) ?? (async () => true), importRemoteSource: async input => {
        const file = await files.importRemoteSource?.call(files, input);
        if (!file) throw new Error("media unavailable in fixture");
        return file;
      },
      getFile: files.getFile?.bind(files) ?? (async () => null), isFileAvailable: files.isFileAvailable?.bind(files) ?? (async () => false) } });
}

export function withMediaServices<T extends object>(services: T): NoInfer<T> & { mediaImportService: MediaImportService; oneBotReferenceResolver: OneBotReferenceResolver } {
  const existing = services as T & { chatFileStore?: ChatFileStore; mediaImportService?: MediaImportService; oneBotReferenceResolver?: OneBotReferenceResolver };
  const files = Object.create(existing.chatFileStore ?? null) as ChatFileStore;
  const imported = new Map<string, Awaited<ReturnType<ChatFileStore["importRemoteSource"]>>>();
  files.importRemoteSource = async input => {
    const file = await existing.chatFileStore?.importRemoteSource(input);
    if (!file) throw new Error("media unavailable in fixture");
    imported.set(file.fileId, file); return file;
  };
  files.getFile = existing.chatFileStore?.getFile?.bind(existing.chatFileStore) ?? (async id => imported.get(id) ?? null);
  files.getMany = existing.chatFileStore?.getMany?.bind(existing.chatFileStore) ?? (async ids => ids.map(id => imported.get(id)!).filter(Boolean));
  files.listFiles = existing.chatFileStore?.listFiles?.bind(existing.chatFileStore) ?? (async () => [...imported.values()]);
  files.isFileAvailable = existing.chatFileStore?.isFileAvailable?.bind(existing.chatFileStore) ?? (async id => imported.has(id));
  files.resolveSelector = existing.chatFileStore?.resolveSelector?.bind(existing.chatFileStore) ?? (async (selector, options = {}) => {
    const direct = await files.getFile(selector);
    if (direct) return direct;
    const records = await files.listFiles();
    return records.find(file => file.fileRef === selector)
      ?? (options.allowName ? records.find(file => file.sourceName === selector || file.chatFilePath === selector || file.chatFilePath?.split("/").at(-1) === selector) : null)
      ?? null;
  });
  const referenceFiles = Object.assign(Object.create(existing.chatFileStore ?? null), { resolveSelector: files.resolveSelector });
  return { ...services, ...(existing.chatFileStore ? { chatFileStore: typeof existing.chatFileStore.importRemoteSource === "function" ? files : referenceFiles } : {}), mediaImportService: existing.mediaImportService ?? createTestMediaImportService(files),
    oneBotReferenceResolver: existing.oneBotReferenceResolver ?? { expand: async (_scope: MediaScope, parts: readonly MessageContentPart[]) => [...parts] } as unknown as OneBotReferenceResolver };
}

export function withReferenceToolServices(context: any, refs: { reply?: string; forward?: string }, sessionId = "qqbot:p:10001"): any {
  const last = context.lastMessage ?? { sessionId, userId: "owner", senderName: "测试发送者" };
  const identity = parseChatSessionIdentity(last.sessionId)!;
  const config = context.config ?? createTestAppConfig();
  const sessions = context.sessionManager ?? new SessionManager(config);
  sessions.ensureSession({ id: last.sessionId, type: identity.kind });
  const hasReferences = sessions.getSession(last.sessionId).internalTranscript.some((item: any) => item.kind === "user_message" && (refs.reply ? item.replyMessageId : item.forwardIds?.length));
  if (!hasReferences) sessions.appendUserHistory(last.sessionId, { chatType: identity.kind, userId: last.userId, senderName: last.senderName, text: "工具测试引用",
    ...(refs.reply ? { replyMessageId: refs.reply } : {}), ...(refs.forward ? { forwardIds: [refs.forward] } : {}) });
  return withMediaServices({ ...context, config, relationship: "known", replyDelivery: "onebot", lastMessage: last, sessionManager: sessions,
    audioStore: context.audioStore ?? { registerSources: async () => [] },
    chatFileStore: context.chatFileStore ?? { importRemoteSource: async () => { throw new Error("media unavailable in fixture"); } },
    oneBotReferenceResolver: context.oneBotReferenceResolver ?? new NativeReferenceResolver(context.oneBotClient, identity.channelId) });
}

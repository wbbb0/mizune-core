import type { Logger } from "pino";
import type { OneBotClient } from "./onebotClient.ts";
import type { ExtractedFileSource } from "./messageSegments.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { ChatFileOrigin, ChatFileRecord } from "#services/workspace/types.ts";

interface ImportOneBotMessageFileInput {
  fileSource: ExtractedFileSource;
  chatFileStore: Pick<ChatFileStore, "importRemoteSource">;
  oneBotClient?: Pick<OneBotClient, "getFile" | "getGroupFileUrl">;
  origin: ChatFileOrigin;
  groupId?: string | null;
  userId: string;
  senderName?: string;
  logger?: Pick<Logger, "warn">;
}

export async function importOneBotMessageFile(input: ImportOneBotMessageFileInput): Promise<ChatFileRecord | null> {
  try {
    const resolved = await resolveOneBotMessageFileSource(input);
    return await input.chatFileStore.importRemoteSource({
      source: resolved.source,
      kind: "file",
      origin: input.origin,
      ...(resolved.sourceName ? { sourceName: resolved.sourceName } : {}),
      ...(input.fileSource.mimeType ? { mimeType: input.fileSource.mimeType } : {}),
      sourceContext: {
        source: resolved.source,
        source_kind: input.fileSource.sourceKind,
        ...(input.fileSource.sourceKind === "onebot_file" ? { onebot_file_id: input.fileSource.fileId } : {}),
        ...(input.fileSource.sourceKind === "direct" && input.fileSource.fileId ? { onebot_file_id: input.fileSource.fileId } : {}),
        ...(input.fileSource.busid != null ? { busid: input.fileSource.busid } : {}),
        ...(input.fileSource.sizeBytes != null ? { source_size_bytes: input.fileSource.sizeBytes } : {}),
        ...(input.groupId ? { group_id: input.groupId } : {}),
        userId: input.userId,
        ...(input.senderName ? { senderName: input.senderName } : {})
      }
    });
  } catch (error: unknown) {
    input.logger?.warn(
      {
        error,
        fileSource: summarizeFileSource(input.fileSource),
        groupId: input.groupId ?? null,
        userId: input.userId
      },
      "chat_file_message_import_failed"
    );
    return null;
  }
}

async function resolveOneBotMessageFileSource(input: ImportOneBotMessageFileInput): Promise<{
  source: string;
  sourceName: string | null;
}> {
  if (input.fileSource.sourceKind === "direct") {
    return {
      source: input.fileSource.source,
      sourceName: input.fileSource.filename
    };
  }

  if (!input.oneBotClient) {
    throw new Error("oneBotClient is required to resolve OneBot file_id");
  }

  if (input.groupId && input.fileSource.busid != null) {
    const result = await input.oneBotClient.getGroupFileUrl(
      input.groupId,
      input.fileSource.fileId,
      input.fileSource.busid
    );
    if (result?.url) {
      return {
        source: result.url,
        sourceName: input.fileSource.filename
      };
    }
  }

  const result = await input.oneBotClient.getFile(input.fileSource.fileId);
  const source = result?.url || result?.file || null;
  if (!source) {
    throw new Error(`OneBot file source not found for file_id=${input.fileSource.fileId}`);
  }
  return {
    source,
    sourceName: input.fileSource.filename ?? result?.fileName ?? null
  };
}

function summarizeFileSource(fileSource: ExtractedFileSource): Record<string, unknown> {
  return fileSource.sourceKind === "direct"
    ? {
        sourceKind: fileSource.sourceKind,
        source: fileSource.source,
        fileId: fileSource.fileId,
        busid: fileSource.busid,
        filename: fileSource.filename,
        mimeType: fileSource.mimeType,
        sizeBytes: fileSource.sizeBytes
      }
    : {
        sourceKind: fileSource.sourceKind,
        fileId: fileSource.fileId,
        busid: fileSource.busid,
        filename: fileSource.filename,
        mimeType: fileSource.mimeType,
        sizeBytes: fileSource.sizeBytes
      };
}

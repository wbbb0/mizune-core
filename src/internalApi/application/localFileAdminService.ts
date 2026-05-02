import { readFile } from "node:fs/promises";
import type { LocalFileItemStat, LocalFileListResult, LocalFileReadResult, LocalFileContentResult, ChatFileRecord } from "#services/workspace/types.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { LocalFileService } from "#services/workspace/localFileService.ts";
import { contentTypeFromPath, resolveSendablePath } from "#services/workspace/sendablePath.ts";
import { chatFileCaptionToDerivedObservation, type DerivedObservation } from "#llm/derivations/derivedObservation.ts";
import type { ContentSafetyStore } from "#contentSafety/contentSafetyStore.ts";
import type { ContentSafetyAuditView } from "#contentSafety/contentSafetyTypes.ts";

export interface AdminWorkspaceFileRecord {
  fileId: string;
  fileRef: string;
  kind: ChatFileRecord["kind"];
  origin: ChatFileRecord["origin"];
  chatFilePath: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContext: Record<string, string | number | boolean | null>;
  caption: string | null;
  captionStatus: ChatFileRecord["captionStatus"];
  captionUpdatedAtMs: number | null;
  captionModelRef: string | null;
  captionError: string | null;
  captionObservation: DerivedObservation;
  contentSafety: ContentSafetyAuditView | null;
}

export interface LocalFileAdminService {
  listItems(path?: string): Promise<LocalFileListResult>;
  statItem(path: string): Promise<LocalFileItemStat>;
  readFile(path: string, options?: { startLine?: number; endLine?: number }): Promise<LocalFileReadResult>;
  readFileContent(path: string): Promise<LocalFileContentResult>;
  readSendableFileContent(path: string): Promise<{ contentType: string; buffer: Buffer }>;
  listFiles(): Promise<{ files: AdminWorkspaceFileRecord[] }>;
  getFile(fileId: string): Promise<{ file: AdminWorkspaceFileRecord | null }>;
  readFileContentById(fileId: string): Promise<{ file: AdminWorkspaceFileRecord | null; buffer: Buffer | null }>;
}

export function createLocalFileAdminService(input: {
  localFileService: Pick<LocalFileService, "listItems" | "statItem" | "readFile" | "readFileContent" | "resolvePath">;
  chatFileStore: Pick<ChatFileStore, "listFiles" | "getFile" | "resolveAbsolutePath">;
  contentSafetyStore?: Pick<ContentSafetyStore, "getViewByFileId">;
}): LocalFileAdminService {
  return {
    async listItems(path = ".") {
      return input.localFileService.listItems(path);
    },

    async statItem(path) {
      return input.localFileService.statItem(path);
    },

    async readFile(path, options) {
      return input.localFileService.readFile(path, options);
    },

    async readFileContent(path) {
      return input.localFileService.readFileContent(path);
    },

    async readSendableFileContent(path) {
      const resolved = resolveSendablePath(input.localFileService, path);
      return {
        contentType: contentTypeFromPath(resolved.sourcePath),
        buffer: await readFile(resolved.absolutePath)
      };
    },

    async listFiles() {
      return {
        files: await Promise.all((await input.chatFileStore.listFiles()).map((file) => mapWorkspaceFileToAdminFile(input, file)))
      };
    },

    async getFile(fileId) {
      const file = await input.chatFileStore.getFile(fileId);
      return {
        file: file ? await mapWorkspaceFileToAdminFile(input, file) : null
      };
    },

    async readFileContentById(fileId) {
      const file = await input.chatFileStore.getFile(fileId);
      if (!file) {
        return {
          file: null,
          buffer: null
        };
      }

      const absolutePath = await input.chatFileStore.resolveAbsolutePath(file.fileId);
      return {
        file: await mapWorkspaceFileToAdminFile(input, file),
        buffer: await readFile(absolutePath)
      };
    }
  };
}

async function mapWorkspaceFileToAdminFile(
  input: Pick<Parameters<typeof createLocalFileAdminService>[0], "contentSafetyStore">,
  file: ChatFileRecord
): Promise<AdminWorkspaceFileRecord> {
  return {
    fileId: file.fileId,
    fileRef: file.fileRef,
    kind: file.kind,
    origin: file.origin,
    chatFilePath: file.chatFilePath,
    sourceName: file.sourceName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAtMs: file.createdAtMs,
    sourceContext: file.sourceContext,
    caption: file.caption,
    captionStatus: file.captionStatus ?? (file.caption ? "ready" : "missing"),
    captionUpdatedAtMs: file.captionUpdatedAtMs ?? null,
    captionModelRef: file.captionModelRef ?? null,
    captionError: file.captionError ?? null,
    captionObservation: chatFileCaptionToDerivedObservation(file),
    contentSafety: await input.contentSafetyStore?.getViewByFileId(file.fileId) ?? null
  };
}

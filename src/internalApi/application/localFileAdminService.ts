import { readFile } from "node:fs/promises";
import type { LocalFileItemStat, LocalFileListResult, LocalFileReadResult, LocalFileContentResult, ChatFileRecord } from "#services/workspace/types.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { LocalFileService } from "#services/workspace/localFileService.ts";
import type { AppConfig } from "#config/config.ts";
import { contentTypeFromPath, resolveSendablePath } from "#services/workspace/sendablePath.ts";

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
  config: AppConfig;
  localFileService: Pick<LocalFileService, "listItems" | "statItem" | "readFile" | "readFileContent" | "resolvePath">;
  chatFileStore: Pick<ChatFileStore, "listFiles" | "getFile" | "resolveAbsolutePath">;
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
      const resolved = resolveSendablePath(input.config, input.localFileService, path);
      return {
        contentType: contentTypeFromPath(resolved.sourcePath),
        buffer: await readFile(resolved.absolutePath)
      };
    },

    async listFiles() {
      return {
        files: (await input.chatFileStore.listFiles()).map(mapWorkspaceFileToAdminFile)
      };
    },

    async getFile(fileId) {
      const file = await input.chatFileStore.getFile(fileId);
      return {
        file: file ? mapWorkspaceFileToAdminFile(file) : null
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
        file: mapWorkspaceFileToAdminFile(file),
        buffer: await readFile(absolutePath)
      };
    }
  };
}

function mapWorkspaceFileToAdminFile(file: ChatFileRecord): AdminWorkspaceFileRecord {
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
    caption: file.caption
  };
}

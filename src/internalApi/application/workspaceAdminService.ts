import { readFile } from "node:fs/promises";
import type { WorkspaceItemStat, WorkspaceListResult, WorkspaceFileReadResult, WorkspaceFileContentResult, WorkspaceStoredFileRecord } from "#services/workspace/types.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { WorkspaceService } from "#services/workspace/workspaceService.ts";

export interface AdminWorkspaceFileRecord {
  fileId: string;
  fileRef: string;
  kind: WorkspaceStoredFileRecord["kind"];
  origin: WorkspaceStoredFileRecord["origin"];
  workspacePath: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContext: Record<string, string | number | boolean | null>;
  caption: string | null;
}

export interface WorkspaceAdminService {
  listItems(path?: string): Promise<WorkspaceListResult>;
  statItem(path: string): Promise<WorkspaceItemStat>;
  readFile(path: string, options?: { startLine?: number; endLine?: number }): Promise<WorkspaceFileReadResult>;
  readFileContent(path: string): Promise<WorkspaceFileContentResult>;
  listFiles(): Promise<{ files: AdminWorkspaceFileRecord[] }>;
  getFile(fileId: string): Promise<{ file: AdminWorkspaceFileRecord | null }>;
  readFileContentById(fileId: string): Promise<{ file: AdminWorkspaceFileRecord | null; buffer: Buffer | null }>;
}

export function createWorkspaceAdminService(input: {
  workspaceService: Pick<WorkspaceService, "listItems" | "statItem" | "readFile" | "readFileContent">;
  mediaWorkspace: Pick<MediaWorkspace, "listFiles" | "getFile" | "resolveAbsolutePath">;
}): WorkspaceAdminService {
  return {
    async listItems(path = ".") {
      return input.workspaceService.listItems(path);
    },

    async statItem(path) {
      return input.workspaceService.statItem(path);
    },

    async readFile(path, options) {
      return input.workspaceService.readFile(path, options);
    },

    async readFileContent(path) {
      return input.workspaceService.readFileContent(path);
    },

    async listFiles() {
      return {
        files: (await input.mediaWorkspace.listFiles()).map(mapWorkspaceFileToAdminFile)
      };
    },

    async getFile(fileId) {
      const file = await input.mediaWorkspace.getFile(fileId);
      return {
        file: file ? mapWorkspaceFileToAdminFile(file) : null
      };
    },

    async readFileContentById(fileId) {
      const file = await input.mediaWorkspace.getFile(fileId);
      if (!file) {
        return {
          file: null,
          buffer: null
        };
      }

      const absolutePath = await input.mediaWorkspace.resolveAbsolutePath(file.fileId);
      return {
        file: mapWorkspaceFileToAdminFile(file),
        buffer: await readFile(absolutePath)
      };
    }
  };
}

function mapWorkspaceFileToAdminFile(file: WorkspaceStoredFileRecord): AdminWorkspaceFileRecord {
  return {
    fileId: file.fileId,
    fileRef: file.fileRef,
    kind: file.kind,
    origin: file.origin,
    workspacePath: file.workspacePath,
    sourceName: file.sourceName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAtMs: file.createdAtMs,
    sourceContext: file.sourceContext,
    caption: file.caption
  };
}

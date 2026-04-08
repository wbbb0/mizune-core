import { readFile } from "node:fs/promises";
import type { WorkspaceItemStat, WorkspaceListResult, WorkspaceFileReadResult, WorkspaceFileContentResult, WorkspaceAssetRecord } from "#services/workspace/types.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { WorkspaceService } from "#services/workspace/workspaceService.ts";

export interface AdminWorkspaceFileRecord {
  fileId: string;
  fileRef: string;
  kind: WorkspaceAssetRecord["kind"];
  origin: WorkspaceAssetRecord["origin"];
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
  mediaWorkspace: Pick<MediaWorkspace, "listAssets" | "getAsset" | "resolveAbsolutePath">;
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
        files: (await input.mediaWorkspace.listAssets()).map(mapWorkspaceAssetToAdminFile)
      };
    },

    async getFile(fileId) {
      const asset = await input.mediaWorkspace.getAsset(fileId);
      return {
        file: asset ? mapWorkspaceAssetToAdminFile(asset) : null
      };
    },

    async readFileContentById(fileId) {
      const asset = await input.mediaWorkspace.getAsset(fileId);
      if (!asset) {
        return {
          file: null,
          buffer: null
        };
      }

      const absolutePath = await input.mediaWorkspace.resolveAbsolutePath(asset.assetId);
      return {
        file: mapWorkspaceAssetToAdminFile(asset),
        buffer: await readFile(absolutePath)
      };
    }
  };
}

function mapWorkspaceAssetToAdminFile(asset: WorkspaceAssetRecord): AdminWorkspaceFileRecord {
  return {
    fileId: asset.assetId,
    fileRef: asset.displayName,
    kind: asset.kind,
    origin: asset.origin,
    workspacePath: asset.storagePath,
    sourceName: asset.filename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    createdAtMs: asset.createdAtMs,
    sourceContext: asset.sourceContext,
    caption: asset.caption
  };
}

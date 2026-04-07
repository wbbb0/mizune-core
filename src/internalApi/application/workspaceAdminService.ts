import { readFile } from "node:fs/promises";
import type { WorkspaceItemStat, WorkspaceListResult, WorkspaceFileReadResult, WorkspaceFileContentResult, WorkspaceAssetRecord } from "#services/workspace/types.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { WorkspaceService } from "#services/workspace/workspaceService.ts";

export interface WorkspaceAdminService {
  listItems(path?: string): Promise<WorkspaceListResult>;
  statItem(path: string): Promise<WorkspaceItemStat>;
  readFile(path: string, options?: { startLine?: number; endLine?: number }): Promise<WorkspaceFileReadResult>;
  readFileContent(path: string): Promise<WorkspaceFileContentResult>;
  listAssets(): Promise<{ assets: WorkspaceAssetRecord[] }>;
  getAsset(assetId: string): Promise<{ asset: WorkspaceAssetRecord | null }>;
  readAssetContent(assetId: string): Promise<{ asset: WorkspaceAssetRecord | null; buffer: Buffer | null }>;
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

    async listAssets() {
      return {
        assets: await input.mediaWorkspace.listAssets()
      };
    },

    async getAsset(assetId) {
      return {
        asset: await input.mediaWorkspace.getAsset(assetId)
      };
    },

    async readAssetContent(assetId) {
      const asset = await input.mediaWorkspace.getAsset(assetId);
      if (!asset) {
        return {
          asset: null,
          buffer: null
        };
      }

      const absolutePath = await input.mediaWorkspace.resolveAbsolutePath(asset.assetId);
      return {
        asset,
        buffer: await readFile(absolutePath)
      };
    }
  };
}

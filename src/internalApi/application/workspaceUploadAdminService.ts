import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { WorkspaceAssetKind } from "#services/workspace/types.ts";

const MAX_UPLOAD_FILE_COUNT = 8;

export interface AdminWorkspaceUploadService {
  uploadAssets(body: {
    files: Array<{
      filename?: string;
      mimeType: string;
      contentBase64: string;
      kind?: WorkspaceAssetKind;
    }>;
  }): Promise<{
    ok: true;
    uploads: Array<{
      assetId: string;
      kind: WorkspaceAssetKind;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }>;
  }>;
}

export function createAdminWorkspaceUploadService(input: {
  mediaWorkspace: Pick<MediaWorkspace, "importBuffer">;
}): AdminWorkspaceUploadService {
  return {
    async uploadAssets(body) {
      if (body.files.length > MAX_UPLOAD_FILE_COUNT) {
        throw new Error(`Too many files in one request; max is ${MAX_UPLOAD_FILE_COUNT}`);
      }
      const uploads = await Promise.all(body.files.map(async (file) => {
        const mimeType = String(file.mimeType ?? "").trim().toLowerCase();
        const buffer = Buffer.from(file.contentBase64, "base64");
        if (buffer.byteLength === 0) {
          throw new Error("Uploaded file is empty");
        }
        const kind = file.kind ?? (mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "file");
        const asset = await input.mediaWorkspace.importBuffer({
          buffer,
          mimeType,
          kind,
          origin: "user_upload",
          ...(file.filename ? { filename: file.filename } : {})
        });
        return {
          assetId: asset.assetId,
          kind: asset.kind,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes
        };
      }));

      return {
        ok: true,
        uploads
      };
    }
  };
}

import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { ChatFileKind } from "#services/workspace/types.ts";

const MAX_UPLOAD_FILE_COUNT = 8;

export interface AdminWorkspaceUploadService {
  uploadFiles(body: {
    files: Array<{
      sourceName?: string;
      mimeType: string;
      contentBase64: string;
      kind?: ChatFileKind;
    }>;
  }): Promise<{
    ok: true;
    uploads: Array<{
      fileId: string;
      fileRef: string;
      kind: ChatFileKind;
      sourceName: string;
      chatFilePath: string;
      mimeType: string;
      sizeBytes: number;
    }>;
  }>;
}

export function createAdminWorkspaceUploadService(input: {
  chatFileStore: Pick<ChatFileStore, "importBuffer">;
}): AdminWorkspaceUploadService {
  return {
    async uploadFiles(body) {
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
        const storedFile = await input.chatFileStore.importBuffer({
          buffer,
          mimeType,
          kind,
          origin: "user_upload",
          ...(file.sourceName ? { sourceName: file.sourceName } : {})
        });
        return {
          fileId: storedFile.fileId,
          fileRef: storedFile.fileRef,
          kind: storedFile.kind,
          sourceName: storedFile.sourceName,
          chatFilePath: storedFile.chatFilePath,
          mimeType: storedFile.mimeType,
          sizeBytes: storedFile.sizeBytes
        };
      }));

      return {
        ok: true,
        uploads
      };
    }
  };
}

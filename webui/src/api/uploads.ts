import { api } from "./client";

export interface UploadedFile {
  fileId: string;
  fileRef: string | null;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  sourceName: string;
  chatFilePath: string | null;
  mimeType: string;
  sizeBytes: number;
}

/** Read a File as base64 string */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data URL prefix: "data:image/png;base64,..."
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export const uploadsApi = {
  async uploadFiles(files: File[]): Promise<{ ok: true; uploads: UploadedFile[] }> {
    const encoded = await Promise.all(
      files.map(async (f) => ({
        sourceName: f.name,
        mimeType: f.type || "application/octet-stream",
        contentBase64: await fileToBase64(f),
        kind: inferUploadKind(f)
      }))
    );
    return api.post("/api/uploads/files", { files: encoded });
  }
};

function inferUploadKind(file: File): UploadedFile["kind"] | undefined {
  const type = file.type.trim().toLowerCase();
  if (type === "image/gif" || /\.(gif|apng)$/i.test(file.name)) {
    return "animated_image";
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  return undefined;
}

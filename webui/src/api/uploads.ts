import { api } from "./client";

export interface UploadedAsset {
  assetId: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  filename: string;
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
  async uploadFiles(files: File[]): Promise<{ ok: true; uploads: UploadedAsset[] }> {
    const encoded = await Promise.all(
      files.map(async (f) => ({
        filename: f.name,
        mimeType: f.type || "application/octet-stream",
        contentBase64: await fileToBase64(f),
        kind: f.type.startsWith("image/") ? ("image" as const) : undefined
      }))
    );
    return api.post("/api/uploads/assets", { files: encoded });
  }
};

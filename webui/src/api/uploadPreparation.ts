export interface UploadPreparationOptions {
  convertHeifToJpeg?: (file: File) => Promise<Blob | File | ArrayBuffer>;
}

const HEIF_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence"
]);

export function isHeifFile(file: Pick<File, "name" | "type">): boolean {
  const normalizedType = file.type.trim().toLowerCase();
  if (HEIF_MIME_TYPES.has(normalizedType)) {
    return true;
  }
  return /\.(heic|heif)$/i.test(file.name);
}

export async function prepareFilesForUpload(
  files: File[],
  options: UploadPreparationOptions = {}
): Promise<File[]> {
  const convertHeifToJpeg = options.convertHeifToJpeg ?? defaultConvertHeifToJpeg;

  return Promise.all(files.map(async (file) => {
    if (!isHeifFile(file)) {
      return file;
    }

    const converted = await convertHeifToJpeg(file);
    return new File([converted], replaceFileExtension(file.name, ".jpg"), {
      type: "image/jpeg",
      lastModified: file.lastModified
    });
  }));
}

async function defaultConvertHeifToJpeg(file: File): Promise<Blob> {
  const { heicTo } = await import("heic-to");
  return heicTo({
    blob: file,
    type: "image/jpeg",
    quality: 0.92
  });
}

function replaceFileExtension(name: string, nextExtension: string): string {
  if (!name) {
    return `image${nextExtension}`;
  }
  return /\.[^.]+$/.test(name)
    ? name.replace(/\.[^.]+$/, nextExtension)
    : `${name}${nextExtension}`;
}

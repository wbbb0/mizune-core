export const COMPOSER_IMAGE_ACCEPT = "image/*,.heic,.heif";

const HEIF_EXTENSIONS = /\.(heic|heif)$/i;

export function isComposerImageFile(file: Pick<File, "name" | "type">): boolean {
  const type = file.type.trim().toLowerCase();
  return type.startsWith("image/") || HEIF_EXTENSIONS.test(file.name);
}

export function filterComposerImageFiles(files: File[]): {
  accepted: File[];
  rejected: File[];
} {
  const accepted: File[] = [];
  const rejected: File[] = [];

  for (const file of files) {
    if (isComposerImageFile(file)) {
      accepted.push(file);
    } else {
      rejected.push(file);
    }
  }

  return { accepted, rejected };
}

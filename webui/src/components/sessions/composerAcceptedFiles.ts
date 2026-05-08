export const COMPOSER_IMAGE_ACCEPT = "image/*,.heic,.heif";
export const COMPOSER_FILE_ACCEPT: string | undefined = undefined;

const HEIF_EXTENSIONS = /\.(heic|heif)$/i;

export function isComposerImageFile(file: Pick<File, "name" | "type">): boolean {
  const type = file.type.trim().toLowerCase();
  return type.startsWith("image/") || HEIF_EXTENSIONS.test(file.name);
}

export function filterComposerFiles(files: File[]): File[] {
  return files;
}

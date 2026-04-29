export type ComposerFileListLike = ArrayLike<File> | null | undefined;

export type ComposerDataTransferItemLike = {
  kind?: string;
  getAsFile?: () => File | null;
};

export type ComposerDataTransferLike = {
  files?: ComposerFileListLike;
  items?: ArrayLike<ComposerDataTransferItemLike> | null;
} | null | undefined;

export function filesFromFileList(fileList: ComposerFileListLike): File[] {
  return fileList ? Array.from(fileList) : [];
}

export function filesFromDataTransfer(dataTransfer: ComposerDataTransferLike): File[] {
  const itemFiles = filesFromDataTransferItems(dataTransfer?.items);
  const listedFiles = filesFromFileList(dataTransfer?.files);
  return [...itemFiles, ...listedFiles];
}

export function filesFromClipboardData(clipboardData: ComposerDataTransferLike): File[] {
  return filesFromDataTransfer(clipboardData);
}

function filesFromDataTransferItems(items: ArrayLike<ComposerDataTransferItemLike> | null | undefined): File[] {
  if (!items) {
    return [];
  }

  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile?.();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

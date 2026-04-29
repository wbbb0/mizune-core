export interface FingerprintedComposerFile {
  file: File;
  fingerprint: string;
}

export interface ComposerFileFingerprintSelection {
  unique: FingerprintedComposerFile[];
  duplicateCount: number;
}

export async function fingerprintComposerFiles(files: File[]): Promise<FingerprintedComposerFile[]> {
  return Promise.all(files.map(async (file) => ({
    file,
    fingerprint: await fingerprintComposerFile(file)
  })));
}

export function selectUniqueComposerFiles(
  files: FingerprintedComposerFile[],
  existingFingerprints: Iterable<string>
): ComposerFileFingerprintSelection {
  const seen = new Set(existingFingerprints);
  const unique: FingerprintedComposerFile[] = [];
  let duplicateCount = 0;

  for (const item of files) {
    if (seen.has(item.fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(item.fingerprint);
    unique.push(item);
  }

  return { unique, duplicateCount };
}

async function fingerprintComposerFile(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return `metadata:${file.size}:${file.lastModified}:${file.type}`;
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const bytes = Array.from(new Uint8Array(digest));
  return `sha256:${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

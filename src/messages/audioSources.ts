import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";

export interface PreparedAudioInput {
  source: string;
  mimeType: string;
  format: string;
  data: string;
}

const FORMAT_BY_EXTENSION: Record<string, { format: string; mimeType: string }> = {
  ".aac": { format: "aac", mimeType: "audio/aac" },
  ".amr": { format: "amr", mimeType: "audio/amr" },
  ".flac": { format: "flac", mimeType: "audio/flac" },
  ".m4a": { format: "m4a", mimeType: "audio/mp4" },
  ".mp3": { format: "mp3", mimeType: "audio/mpeg" },
  ".mp4": { format: "mp4", mimeType: "audio/mp4" },
  ".mpeg": { format: "mpeg", mimeType: "audio/mpeg" },
  ".mpga": { format: "mpga", mimeType: "audio/mpeg" },
  ".oga": { format: "ogg", mimeType: "audio/ogg" },
  ".ogg": { format: "ogg", mimeType: "audio/ogg" },
  ".wav": { format: "wav", mimeType: "audio/wav" },
  ".webm": { format: "webm", mimeType: "audio/webm" }
};

const FORMAT_BY_MIME_TYPE: Record<string, { format: string; mimeType: string }> = {
  "audio/aac": { format: "aac", mimeType: "audio/aac" },
  "audio/amr": { format: "amr", mimeType: "audio/amr" },
  "audio/flac": { format: "flac", mimeType: "audio/flac" },
  "audio/mp3": { format: "mp3", mimeType: "audio/mpeg" },
  "audio/mp4": { format: "m4a", mimeType: "audio/mp4" },
  "audio/mpeg": { format: "mp3", mimeType: "audio/mpeg" },
  "audio/ogg": { format: "ogg", mimeType: "audio/ogg" },
  "audio/wav": { format: "wav", mimeType: "audio/wav" },
  "audio/webm": { format: "webm", mimeType: "audio/webm" },
  "audio/x-flac": { format: "flac", mimeType: "audio/flac" },
  "audio/x-m4a": { format: "m4a", mimeType: "audio/mp4" },
  "audio/x-wav": { format: "wav", mimeType: "audio/wav" }
};

export async function prepareAudioInputsForModel(
  sources: string[],
  deps: {
    oneBotClient: Pick<OneBotClient, "getRecord">;
  },
  options?: {
    maxInputs?: number;
  }
): Promise<PreparedAudioInput[]> {
  const maxInputs = Math.max(1, options?.maxInputs ?? 3);
  const prepared: PreparedAudioInput[] = [];
  const seen = new Set<string>();

  for (const rawSource of sources) {
    const source = String(rawSource ?? "").trim();
    if (!source || seen.has(source)) {
      continue;
    }
    seen.add(source);
    const resolved = await prepareAudioInput(source, deps, new Set<string>());
    if (resolved) {
      prepared.push(resolved);
    }
    if (prepared.length >= maxInputs) {
      break;
    }
  }

  return prepared;
}

async function prepareAudioInput(
  source: string,
  deps: {
    oneBotClient: Pick<OneBotClient, "getRecord">;
  },
  visited: Set<string>
): Promise<PreparedAudioInput | null> {
  if (visited.has(source)) {
    return null;
  }
  visited.add(source);

  const dataUrlMatch = source.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i);
  if (dataUrlMatch) {
    const mimeType = normalizeMimeType(String(dataUrlMatch[1] ?? ""));
    const normalized = resolveAudioFormat(mimeType);
    return {
      source,
      mimeType: normalized.mimeType,
      format: normalized.format,
      data: String(dataUrlMatch[2] ?? "")
    };
  }

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`audio fetch failed: ${response.status} ${response.statusText}`.trim());
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = normalizeMimeType(response.headers.get("content-type"));
    const normalized = resolveAudioFormat(contentType, source);
    return {
      source,
      mimeType: normalized.mimeType,
      format: normalized.format,
      data: bytes.toString("base64")
    };
  }

  if (source.startsWith("file://")) {
    return readAudioFile(fileURLToPath(source), source);
  }

  if (looksLikePath(source)) {
    const absolutePath = isAbsolute(source) ? source : resolve(process.cwd(), source);
    return readAudioFile(absolutePath, source);
  }

  const resolvedRecord = await deps.oneBotClient.getRecord(source, "mp3");
  const recordSource = resolvedRecord.file ?? resolvedRecord.url;
  if (!recordSource) {
    return null;
  }

  return prepareAudioInput(recordSource, deps, visited);
}

async function readAudioFile(filePath: string, source: string): Promise<PreparedAudioInput> {
  const bytes = await readFile(filePath);
  const normalized = resolveAudioFormat(null, filePath);
  return {
    source,
    mimeType: normalized.mimeType,
    format: normalized.format,
    data: bytes.toString("base64")
  };
}

function resolveAudioFormat(mimeType: string | null, source?: string): { format: string; mimeType: string } {
  if (mimeType) {
    const normalizedMimeType = normalizeMimeType(mimeType);
    const matchedMimeType = FORMAT_BY_MIME_TYPE[normalizedMimeType];
    if (matchedMimeType) {
      return matchedMimeType;
    }
  }

  const sourceWithoutQuery = String(source ?? "").split("?")[0] ?? "";
  const extension = extname(sourceWithoutQuery.toLowerCase());
  if (extension && FORMAT_BY_EXTENSION[extension]) {
    return FORMAT_BY_EXTENSION[extension];
  }

  return {
    format: "mp3",
    mimeType: mimeType ? normalizeMimeType(mimeType) : "audio/mpeg"
  };
}

function looksLikePath(source: string): boolean {
  return isAbsolute(source)
    || source.startsWith("./")
    || source.startsWith("../");
}

function normalizeMimeType(value: string | null): string {
  const mimeType = String(value ?? "").split(";")[0] ?? "";
  return mimeType
    .trim()
    .toLowerCase();
}

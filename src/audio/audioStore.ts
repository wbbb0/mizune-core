import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const transcriptionStatusSchema = z.enum(["missing", "queued", "ready", "failed"]);

const storedAudioAssetSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  transcription: z.string().min(1).nullable().optional(),
  transcriptionStatus: transcriptionStatusSchema.optional(),
  transcriptionUpdatedAt: z.number().int().nonnegative().optional(),
  transcriptionModelRef: z.string().min(1).nullable().optional(),
  transcriptionError: z.string().min(1).nullable().optional()
});

const audioAssetFileSchema = z.object({
  version: z.literal(1),
  audios: z.array(storedAudioAssetSchema)
});

export type AudioTranscriptionStatus = z.infer<typeof transcriptionStatusSchema>;
export type StoredAudioAsset = z.infer<typeof storedAudioAssetSchema> & {
  transcription: string | null;
  transcriptionStatus: AudioTranscriptionStatus;
  transcriptionModelRef: string | null;
  transcriptionError: string | null;
};

export class AudioStore {
  private readonly filePath: string;
  private cachedAudios: StoredAudioAsset[] | null = null;
  private cachedMtimeMs: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "audio-assets.json");
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.readAll();
  }

  async registerSources(sources: string[]): Promise<StoredAudioAsset[]> {
    const normalized = sources
      .map((source) => String(source ?? "").trim())
      .filter(Boolean);
    if (normalized.length === 0) {
      return [];
    }

    return this.withStoreLock(async () => {
      const existing = await this.readAll();
      const next = [...existing];
      const created: StoredAudioAsset[] = [];

      for (const source of normalized) {
        const asset = normalizeStoredAudioAsset({
          id: `aud_${randomUUID().replace(/-/g, "")}`,
          source,
          createdAt: Date.now(),
          transcription: null,
          transcriptionStatus: "missing",
          transcriptionModelRef: null,
          transcriptionError: null
        });
        next.push(asset);
        created.push(asset);
      }

      await this.writeAll(next);
      return created;
    });
  }

  async get(audioId: string): Promise<StoredAudioAsset | null> {
    const audios = await this.readAll();
    return audios.find((item) => item.id === audioId) ?? null;
  }

  async getMany(audioIds: string[]): Promise<StoredAudioAsset[]> {
    const ids = new Set(audioIds.map((item) => String(item ?? "").trim()).filter(Boolean));
    if (ids.size === 0) {
      return [];
    }
    const audios = await this.readAll();
    return audios.filter((item) => ids.has(item.id));
  }

  async getTranscriptionMap(audioIds: string[]): Promise<Map<string, string>> {
    const assets = await this.getMany(audioIds);
    return new Map(
      assets
        .filter((item) => item.transcriptionStatus === "ready" && typeof item.transcription === "string" && item.transcription.length > 0)
        .map((item) => [item.id, item.transcription as string])
    );
  }

  async markTranscriptionsQueued(audioIds: string[]): Promise<void> {
    const ids = uniqueAudioIds(audioIds);
    if (ids.length === 0) {
      return;
    }

    await this.withStoreLock(async () => {
      const audios = await this.readAll();
      let changed = false;
      const next = audios.map((item) => {
        if (!ids.includes(item.id) || item.transcriptionStatus === "ready" || item.transcriptionStatus === "queued") {
          return item;
        }
        changed = true;
        return {
          ...item,
          transcriptionStatus: "queued" as const,
          transcriptionError: null
        };
      });
      if (changed) {
        await this.writeAll(next);
      }
    });
  }

  async saveTranscriptionSuccess(
    audioId: string,
    payload: {
      transcription: string;
      modelRef: string;
    }
  ): Promise<void> {
    await this.withStoreLock(async () => {
      const audios = await this.readAll();
      await this.writeAll(audios.map((item) => (
        item.id !== audioId
          ? item
          : {
              ...item,
              transcription: payload.transcription,
              transcriptionStatus: "ready" as const,
              transcriptionUpdatedAt: Date.now(),
              transcriptionModelRef: payload.modelRef,
              transcriptionError: null
            }
      )));
    });
  }

  async saveTranscriptionFailure(
    audioId: string,
    payload: {
      message: string;
      modelRef: string;
    }
  ): Promise<void> {
    await this.withStoreLock(async () => {
      const audios = await this.readAll();
      await this.writeAll(audios.map((item) => (
        item.id !== audioId
          ? item
          : {
              ...item,
              transcriptionStatus: "failed" as const,
              transcriptionUpdatedAt: Date.now(),
              transcriptionModelRef: payload.modelRef,
              transcriptionError: payload.message.slice(0, 240),
              transcription: item.transcription ?? null
            }
      )));
    });
  }

  private async readAll(): Promise<StoredAudioAsset[]> {
    try {
      const stats = await stat(this.filePath);
      if (this.cachedAudios && this.cachedMtimeMs === stats.mtimeMs) {
        return this.cachedAudios;
      }
      const raw = await readFile(this.filePath, "utf8");
      const parsed = audioAssetFileSchema.parse(JSON.parse(raw));
      const audios = parsed.audios.map(normalizeStoredAudioAsset);
      this.cachedAudios = audios;
      this.cachedMtimeMs = stats.mtimeMs;
      return audios;
    } catch {
      const empty: StoredAudioAsset[] = [];
      this.cachedAudios = empty;
      this.cachedMtimeMs = null;
      return empty;
    }
  }

  private async writeAll(audios: StoredAudioAsset[]): Promise<void> {
    const payload = {
      version: 1 as const,
      audios
    };
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
    this.cachedAudios = audios;
    try {
      this.cachedMtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch {
      this.cachedMtimeMs = null;
    }
  }

  private async withStoreLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

function normalizeStoredAudioAsset(value: z.infer<typeof storedAudioAssetSchema>): StoredAudioAsset {
  return {
    ...value,
    transcription: value.transcription ?? null,
    transcriptionStatus: value.transcriptionStatus ?? "missing",
    transcriptionModelRef: value.transcriptionModelRef ?? null,
    transcriptionError: value.transcriptionError ?? null
  };
}

function uniqueAudioIds(audioIds: string[]): string[] {
  return Array.from(new Set(audioIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

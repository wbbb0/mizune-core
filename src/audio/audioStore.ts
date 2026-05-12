import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { s } from "#data/schema/index.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { AssetsDatabase } from "#data/assets/assetsDatabase.ts";

const transcriptionStatusSchema = z.enum(["missing", "queued", "ready", "failed"]);

const storedAudioFileSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  transcription: z.string().min(1).nullable().optional(),
  transcriptionStatus: transcriptionStatusSchema.optional(),
  transcriptionUpdatedAt: z.number().int().nonnegative().nullable().optional(),
  transcriptionModelRef: z.string().min(1).nullable().optional(),
  transcriptionError: z.string().min(1).nullable().optional()
});

export const storedAudioFileRegistrySchema = s.object({
  id: s.string().trim().nonempty(),
  source: s.string().trim().nonempty(),
  createdAt: s.number().int().min(0),
  transcription: s.union([s.string().trim().nonempty(), s.literal(null)]).default(null),
  transcriptionStatus: s.enum(["missing", "queued", "ready", "failed"] as const).default("missing"),
  transcriptionUpdatedAt: s.union([s.number().int().min(0), s.literal(null)]).default(null),
  transcriptionModelRef: s.union([s.string().trim().nonempty(), s.literal(null)]).default(null),
  transcriptionError: s.union([s.string().trim().nonempty(), s.literal(null)]).default(null)
}).strict();

export type AudioTranscriptionStatus = z.infer<typeof transcriptionStatusSchema>;
export type StoredAudioFile = z.infer<typeof storedAudioFileSchema> & {
  transcription: string | null;
  transcriptionStatus: AudioTranscriptionStatus;
  transcriptionUpdatedAt: number | null;
  transcriptionModelRef: string | null;
  transcriptionError: string | null;
};

export class AudioStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    logger: Logger,
    private readonly assetsDatabase = new AssetsDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.assetsDatabase.init();
  }

  async registerSources(sources: string[]): Promise<StoredAudioFile[]> {
    const normalized = sources
      .map((source) => String(source ?? "").trim())
      .filter(Boolean);
    if (normalized.length === 0) {
      return [];
    }

    return this.withStoreLock(async () => {
      const db = await this.getReadyDb();
      const created: StoredAudioFile[] = [];

      for (const source of normalized) {
        const audioFile = normalizeStoredAudioFile({
          id: `aud_${randomUUID().replace(/-/g, "")}`,
          source,
          createdAt: Date.now(),
          transcription: null,
          transcriptionStatus: "missing",
          transcriptionUpdatedAt: null,
          transcriptionModelRef: null,
          transcriptionError: null
        });
        insertAudioRow(db, audioFile);
        created.push(audioFile);
      }

      return created;
    });
  }

  async get(audioId: string): Promise<StoredAudioFile | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT
        id,
        source,
        created_at_ms AS createdAt,
        transcription,
        transcription_status AS transcriptionStatus,
        transcription_updated_at_ms AS transcriptionUpdatedAt,
        transcription_model_ref AS transcriptionModelRef,
        transcription_error AS transcriptionError
      FROM audio_files
      WHERE id = ?
    `).get(audioId) as AudioRow | undefined;
    return row ? normalizeStoredAudioFile(row) : null;
  }

  async getMany(audioIds: string[]): Promise<StoredAudioFile[]> {
    const ids = new Set(audioIds.map((item) => String(item ?? "").trim()).filter(Boolean));
    if (ids.size === 0) {
      return [];
    }
    const audios = await this.listAll();
    return audios.filter((item) => ids.has(item.id));
  }

  async getTranscriptionMap(audioIds: string[]): Promise<Map<string, string>> {
    const audioFiles = await this.getMany(audioIds);
    return new Map(
      audioFiles
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
      const db = await this.getReadyDb();
      const update = db.prepare(`
        UPDATE audio_files
        SET transcription_status = 'queued',
            transcription_error = NULL
        WHERE id = ?
          AND transcription_status NOT IN ('ready', 'queued')
      `);
      for (const id of ids) {
        update.run(id);
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
      const db = await this.getReadyDb();
      db.prepare(`
        UPDATE audio_files
        SET transcription = ?,
            transcription_status = 'ready',
            transcription_updated_at_ms = ?,
            transcription_model_ref = ?,
            transcription_error = NULL
        WHERE id = ?
      `).run(payload.transcription, Date.now(), payload.modelRef, audioId);
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
      const db = await this.getReadyDb();
      db.prepare(`
        UPDATE audio_files
        SET transcription_status = 'failed',
            transcription_updated_at_ms = ?,
            transcription_model_ref = ?,
            transcription_error = ?
        WHERE id = ?
      `).run(Date.now(), payload.modelRef, payload.message.slice(0, 240), audioId);
    });
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: StoredAudioFile[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const db = await this.getReadyDb();
    const total = (db.prepare("SELECT COUNT(*) AS count FROM audio_files").get() as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        id,
        source,
        created_at_ms AS createdAt,
        transcription,
        transcription_status AS transcriptionStatus,
        transcription_updated_at_ms AS transcriptionUpdatedAt,
        transcription_model_ref AS transcriptionModelRef,
        transcription_error AS transcriptionError
      FROM audio_files
      ORDER BY created_at_ms DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as AudioRow[];
    return { rows: rows.map(normalizeStoredAudioFile), total, offset, limit };
  }

  async getRow(audioId: string): Promise<StoredAudioFile | null> {
    return this.get(audioId);
  }

  async deleteAudio(audioId: string): Promise<boolean> {
    const normalizedAudioId = String(audioId ?? "").trim();
    if (!normalizedAudioId) {
      return false;
    }
    return this.withStoreLock(async () => {
      const db = await this.getReadyDb();
      const result = db.prepare("DELETE FROM audio_files WHERE id = ?").run(normalizedAudioId);
      return result.changes > 0;
    });
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

  private async getReadyDb(): Promise<SqliteDatabase> {
    await this.assetsDatabase.init();
    return this.assetsDatabase.getDb();
  }

  private async listAll(): Promise<StoredAudioFile[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        id,
        source,
        created_at_ms AS createdAt,
        transcription,
        transcription_status AS transcriptionStatus,
        transcription_updated_at_ms AS transcriptionUpdatedAt,
        transcription_model_ref AS transcriptionModelRef,
        transcription_error AS transcriptionError
      FROM audio_files
      ORDER BY created_at_ms DESC, id ASC
    `).all() as AudioRow[];
    return rows.map(normalizeStoredAudioFile);
  }
}

type AudioRow = z.infer<typeof storedAudioFileSchema>;

function normalizeStoredAudioFile(value: AudioRow): StoredAudioFile {
  return {
    ...value,
    transcription: value.transcription ?? null,
    transcriptionStatus: value.transcriptionStatus ?? "missing",
    transcriptionUpdatedAt: value.transcriptionUpdatedAt ?? null,
    transcriptionModelRef: value.transcriptionModelRef ?? null,
    transcriptionError: value.transcriptionError ?? null
  };
}

function insertAudioRow(db: SqliteDatabase, audio: StoredAudioFile): void {
  db.prepare(`
    INSERT INTO audio_files (
      id,
      source,
      created_at_ms,
      transcription,
      transcription_status,
      transcription_updated_at_ms,
      transcription_model_ref,
      transcription_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audio.id,
    audio.source,
    audio.createdAt,
    audio.transcription,
    audio.transcriptionStatus,
    audio.transcriptionUpdatedAt,
    audio.transcriptionModelRef,
    audio.transcriptionError
  );
}

function uniqueAudioIds(audioIds: string[]): string[] {
  return Array.from(new Set(audioIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

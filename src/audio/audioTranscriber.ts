import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { normalizeModelRefs } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { KeyedDerivationRunner } from "#llm/derivations/keyedDerivationRunner.ts";
import { prepareAudioInputsForModel } from "#messages/audioSources.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { AudioStore } from "./audioStore.ts";

export interface AudioTranscriptionResult {
  audioId: string;
  status: "ready" | "failed";
  text?: string;
  error?: string | null;
}

function normalizeTranscription(raw: string): string {
  const singleLine = raw
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  return singleLine || "[无法识别]";
}

export class AudioTranscriber {
  private readonly runner: KeyedDerivationRunner;

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly audioStore: AudioStore,
    private readonly oneBotClient: Pick<OneBotClient, "getRecord">,
    private readonly logger: Logger
  ) {
    this.runner = new KeyedDerivationRunner({
      name: "audio_transcription",
      maxConcurrency: () => this.config.llm.audioTranscription.maxConcurrency,
      run: (audioId, signal) => this.runTranscription(audioId, signal),
      logger: this.logger
    });
  }

  isEnabled(): boolean {
    const accepted = getModelRefsForRole(this.config, "audio_transcription");
    return this.config.llm.enabled
      && this.config.llm.audioTranscription.enabled
      && accepted.length > 0
      && this.llmClient.isCapabilityConfigured("transcription", accepted);
  }

  getResolvedModelRefs(): string[] {
    return getModelRefsForRole(this.config, "audio_transcription");
  }

  schedule(audioIds: string[], reason: string): void {
    if (!this.isEnabled()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("音频后台准备超时")), this.config.llm.audioTranscription.timeoutMs);
    timer.unref?.();
    void this.ensureReady(audioIds, { reason, abortSignal: controller.signal })
      .catch(error => {
        if (!controller.signal.aborted) this.logger.warn({ error }, "audio_transcription_background_failed");
      }).finally(() => clearTimeout(timer));
  }

  async ensureReady(audioIds: string[], options?: {
    reason?: string;
    abortSignal?: AbortSignal;
    onProgress?: (results: ReadonlyMap<string, AudioTranscriptionResult>) => void;
  }): Promise<Map<string, AudioTranscriptionResult>> {
    const signal = options?.abortSignal;
    signal?.throwIfAborted();
    const ids = uniqueAudioIds(audioIds);
    const results = await this.getResultMap(ids);
    signal?.throwIfAborted();
    options?.onProgress?.(results);
    if (!ids.length || !this.isEnabled()) return results;
    const existing = await this.audioStore.getMany(ids);
    signal?.throwIfAborted();
    const pending = existing.filter(file => file.transcriptionStatus !== "ready").map(file => file.id);
    const lease = this.runner.acquire(pending, {
      ...(signal ? { abortSignal: signal } : {}), context: { reason: options?.reason ?? "ensure_ready" }
    });
    try {
      await Promise.all([...lease.completed].map(async ([audioId, done]) => {
        await done;
        signal?.throwIfAborted();
        const completed = await this.getResultMap([audioId]);
        signal?.throwIfAborted();
        for (const [id, result] of completed) results.set(id, result);
        options?.onProgress?.(new Map(results));
      }).concat([lease.completion]));
      return results;
    } finally {
      lease.release();
    }
  }

  async stop(): Promise<void> { await this.runner.close(); }

  private async runTranscription(audioId: string, signal: AbortSignal): Promise<void> {
    const modelRefs = this.getResolvedModelRefs();
    try {
      signal.throwIfAborted();
      const audioFile = await this.audioStore.get(audioId);
      signal.throwIfAborted();
      if (!audioFile || audioFile.transcriptionStatus === "ready") {
        return;
      }
      await this.audioStore.markTranscriptionsQueued([audioId], signal);
      signal.throwIfAborted();
      const prepared = await prepareAudioInputsForModel([audioFile.source], {
        oneBotClient: this.oneBotClient
      }, {
        maxInputs: 1, abortSignal: signal
      });
      signal.throwIfAborted();
      const audio = prepared[0];
      if (!audio) {
        throw new Error(`Audio not found for transcription: ${audioId}`);
      }

      const result = await this.llmClient.transcribe({
        modelRefOverride: modelRefs,
        timeoutMsOverride: this.config.llm.audioTranscription.timeoutMs,
        skipDebugDump: true,
        abortSignal: signal,
        audio: { data: audio.data, format: audio.format, mimeType: audio.mimeType }
      });
      signal.throwIfAborted();
      const transcription = normalizeTranscription(result.text);
      const resolvedModelRef = result.usage.modelRef ?? normalizeModelRefs(modelRefs)[0] ?? "unknown";
      await this.audioStore.saveTranscriptionSuccess(audioId, {
        transcription,
        modelRef: resolvedModelRef
      }, signal);
      this.logger.debug({ audioId, modelRef: resolvedModelRef }, "audio_transcriber_succeeded");
    } catch (error: unknown) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      const resolvedModelRef = normalizeModelRefs(modelRefs)[0] ?? "unknown";
      await this.audioStore.saveTranscriptionFailure(audioId, {
        message,
        modelRef: resolvedModelRef
      }, signal);
      this.logger.warn({ audioId, modelRef: resolvedModelRef, error: message }, "audio_transcriber_failed");
    } finally {
      if (signal.aborted) await this.audioStore.clearTranscriptionQueued(audioId, () => !this.runner.hasTask(audioId));
    }
  }

  async getResultMap(audioIds: string[]): Promise<Map<string, AudioTranscriptionResult>> {
    const audioFiles = await this.audioStore.getMany(audioIds);
    return new Map(audioFiles.map((audioFile) => [
      audioFile.id,
      audioFile.transcriptionStatus === "ready"
        ? {
            audioId: audioFile.id,
            status: "ready" as const,
            text: audioFile.transcription ?? ""
          }
        : {
            audioId: audioFile.id,
            status: "failed" as const,
            error: audioFile.transcriptionError ?? null
          }
    ]));
  }


}

function uniqueAudioIds(audioIds: string[]): string[] {
  return Array.from(new Set(audioIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

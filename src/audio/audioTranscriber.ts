import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
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

function buildTranscriptionPrompt(): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是聊天音频听写器，只负责把输入音频尽量准确地转成简洁中文文本。",
        "优先保留用户实际说出的内容，不要总结，不要润色，不要补充猜测。",
        "如果音频里主要是语气词、环境音、噪声、音乐、听不清内容或无法识别，请明确输出“[无法识别]”或一句简短原因。",
        "输出单段纯文本，不加引号、编号或额外解释。"
      ].join("\n")
    }
  ];
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
      run: (audioId) => this.runTranscription(audioId),
      logger: this.logger
    });
  }

  isEnabled(): boolean {
    const accepted = getModelRefsForRole(this.config, "audio_transcription");
    return this.config.llm.enabled
      && this.config.llm.audioTranscription.enabled
      && accepted.length > 0
      && this.llmClient.isConfigured(accepted);
  }

  getResolvedModelRefs(): string[] {
    return getModelRefsForRole(this.config, "audio_transcription");
  }

  schedule(audioIds: string[], reason: string): void {
    const ids = uniqueAudioIds(audioIds);
    if (!this.isEnabled() || ids.length === 0) {
      return;
    }
    void this.enqueue(ids, reason);
  }

  async ensureReady(
    audioIds: string[],
    options?: {
      reason?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<Map<string, AudioTranscriptionResult>> {
    const ids = uniqueAudioIds(audioIds);
    if (ids.length === 0) {
      return new Map();
    }

    if (!this.isEnabled()) {
      return this.buildResultMap(ids);
    }

    await this.enqueue(ids, options?.reason ?? "ensure_ready");
    await Promise.all(ids.map((audioId) => this.waitForCompletion(audioId, options?.abortSignal)));
    return this.buildResultMap(ids);
  }

  private async enqueue(audioIds: string[], reason: string): Promise<void> {
    const existing = await this.audioStore.getMany(audioIds);
    const pendingIds = existing
      .filter((item) => item.transcriptionStatus !== "ready")
      .map((item) => item.id);
    if (pendingIds.length === 0) {
      return;
    }

    await this.audioStore.markTranscriptionsQueued(pendingIds);
    this.logger.debug({ audioCount: pendingIds.length, reason }, "audio_transcriber_enqueued");
    this.runner.enqueue(pendingIds, { reason });
  }

  private async runTranscription(audioId: string): Promise<void> {
    const modelRefs = this.getResolvedModelRefs();
    try {
      const audioFile = await this.audioStore.get(audioId);
      if (!audioFile || audioFile.transcriptionStatus === "ready") {
        return;
      }
      const prepared = await prepareAudioInputsForModel([audioFile.source], {
        oneBotClient: this.oneBotClient
      }, {
        maxInputs: 1
      });
      const audio = prepared[0];
      if (!audio) {
        throw new Error(`Audio not found for transcription: ${audioId}`);
      }

      const result = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        timeoutMsOverride: this.config.llm.audioTranscription.timeoutMs,
        enableThinkingOverride: this.config.llm.audioTranscription.enableThinking,
        skipDebugDump: true,
        messages: [
          ...buildTranscriptionPrompt(),
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "请转写这段聊天音频。"
              },
              {
                type: "input_audio",
                input_audio: {
                  data: audio.data,
                  format: audio.format,
                  mimeType: audio.mimeType
                }
              }
            ]
          }
        ]
      });
      const transcription = normalizeTranscription(result.text);
      const resolvedModelRef = result.usage.modelRef ?? normalizeModelRefs(modelRefs)[0] ?? "unknown";
      await this.audioStore.saveTranscriptionSuccess(audioId, {
        transcription,
        modelRef: resolvedModelRef
      });
      this.logger.debug({ audioId, modelRef: resolvedModelRef }, "audio_transcriber_succeeded");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const resolvedModelRef = normalizeModelRefs(modelRefs)[0] ?? "unknown";
      await this.audioStore.saveTranscriptionFailure(audioId, {
        message,
        modelRef: resolvedModelRef
      });
      this.logger.warn({ audioId, modelRef: resolvedModelRef, error: message }, "audio_transcriber_failed");
    }
  }

  private async buildResultMap(audioIds: string[]): Promise<Map<string, AudioTranscriptionResult>> {
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

  private async waitForCompletion(audioId: string, abortSignal?: AbortSignal): Promise<void> {
    const existing = await this.audioStore.get(audioId);
    if (!existing || existing.transcriptionStatus === "ready" || existing.transcriptionStatus === "failed") {
      return;
    }
    await this.runner.waitForCompletion(audioId, abortSignal);
  }
}

function uniqueAudioIds(audioIds: string[]): string[] {
  return Array.from(new Set(audioIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

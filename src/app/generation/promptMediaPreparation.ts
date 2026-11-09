import { collectVisualAttachmentFileIds } from "#services/workspace/chatAttachments.ts";
import { walkMessageContentParts } from "#messages/contentParts.ts";
import type { GenerationPromptBatchMessage } from "./generationPromptBuilder.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import { parseProtocolLine } from "#utils/structuredEnvelope.ts";
import { foldMessageForModel } from "#messages/modelMessageProjection.ts";

export interface CurrentMediaAdmission {
  fileIds: ReadonlySet<string>;
  audioIds: ReadonlySet<string>;
  audioSources: ReadonlySet<string>;
  mediaRefs: ReadonlySet<string>;
  omitted: number;
}

type MediaCandidate = { fileId?: string; audioId?: string; audioSource?: string; mediaRef?: string };

function selectAdmission(entries: ReadonlyMap<string, MediaCandidate>, limit: number): CurrentMediaAdmission {
  const selected = [...entries.values()].slice(0, Math.max(0, limit));
  return {
    fileIds: new Set(selected.flatMap(entry => entry.fileId ? [entry.fileId] : [])),
    audioIds: new Set(selected.flatMap(entry => entry.audioId ? [entry.audioId] : [])),
    audioSources: new Set(selected.flatMap(entry => entry.audioSource ? [entry.audioSource] : [])),
    mediaRefs: new Set(selected.flatMap(entry => entry.mediaRef ? [entry.mediaRef] : [])),
    omitted: Math.max(0, entries.size - selected.length)
  };
}

/** 两种历史表示共享资源集合，按最近出现优先准入；保留所有未准入的显示引用。 */
export function admitHistoryPromptMedia(
  history: readonly { content: string }[], replay: readonly LlmMessage[], limit: number,
  covered?: CurrentMediaAdmission
): CurrentMediaAdmission {
  const entries = new Map<string, MediaCandidate>();
  const messages = [...history, ...replay.flatMap(message => typeof message.content === "string" ? [{ content: message.content }] : [])];
  for (const message of messages.reverse()) {
    for (const line of message.content.replace(/\r\n/g, "\n").split("\n").reverse()) {
      const tag = parseProtocolLine(line);
      if (!tag) continue;
      const isImage = tag.tag === "ref" && (tag.attrs.kind === "image" || tag.attrs.kind === "emoji");
      const fileId = isImage ? tag.attrs.image_id : tag.tag === "asset_file" ? tag.attrs.file_id : undefined;
      const audioId = tag.tag === "audio" ? tag.attrs.audio_id : undefined;
      const mediaRef = ["ref", "pending_media", "asset_file"].includes(tag.tag) ? tag.attrs.media_ref : undefined;
      const key = fileId && fileId !== "omitted" ? `file:${fileId}` : audioId ? `audio:${audioId}` : mediaRef ? `media:${mediaRef}` : null;
      if (key && !covered?.fileIds.has(fileId ?? "") && !covered?.audioIds.has(audioId ?? "")
        && !covered?.mediaRefs.has(mediaRef ?? "") && !entries.has(key)) entries.set(key, {
        ...(fileId && fileId !== "omitted" ? { fileId } : {}), ...(audioId ? { audioId } : {}), ...(mediaRef ? { mediaRef } : {})
      });
    }
  }
  const admission = selectAdmission(entries, limit);
  return covered ? { ...admission,
    fileIds: new Set([...admission.fileIds, ...covered.fileIds]),
    audioIds: new Set([...admission.audioIds, ...covered.audioIds]),
    mediaRefs: new Set([...admission.mediaRefs, ...covered.mediaRefs])
  } : admission;
}

/** 当前输入与历史窗口独立计量；额度约束自动准备，不删除输入中的文本和资源句柄。 */
export function admitCurrentPromptMedia(messages: readonly GenerationPromptBatchMessage[], maxMedia: number): CurrentMediaAdmission {
  const entries = new Map<string, MediaCandidate>();
  for (const rawMessage of messages) {
    const message = foldMessageForModel(rawMessage);
    for (const part of walkMessageContentParts(message.contentParts)) {
      if (part.kind === "image" || part.kind === "emoji") {
        const key = part.fileId ? `file:${part.fileId}` : part.mediaRef ? `media:${part.mediaRef}` : null;
        if (key) entries.set(key, { ...(part.fileId ? { fileId: part.fileId } : {}), ...(part.mediaRef ? { mediaRef: part.mediaRef } : {}) });
      } else if (part.kind === "asset_file" && (part.mediaRef || part.fileKind === "image" || part.fileKind === "animated_image")) {
        entries.set(`file:${part.fileId}`, { fileId: part.fileId, ...(part.mediaRef ? { mediaRef: part.mediaRef } : {}) });
      } else if (part.kind === "pending_media") {
        entries.set(`media:${part.mediaRef}`, { mediaRef: part.mediaRef });
      }
    }
    for (const fileId of [...collectVisualAttachmentFileIds(message.attachments, "image"), ...collectVisualAttachmentFileIds(message.attachments, "emoji"), ...message.imageIds, ...message.emojiIds]) {
      if (!entries.has(`file:${fileId}`)) entries.set(`file:${fileId}`, { fileId });
    }
    const audioIds = message.audioIds ?? [];
    const sources = message.audioSources ?? [];
    for (let index = 0; index < Math.max(audioIds.length, sources.length); index += 1) {
      const audioId = audioIds[index];
      const audioSource = sources[index];
      const key = audioId ? `audio:${audioId}` : audioSource ? `source:${audioSource}` : null;
      if (key) entries.set(key, { ...(audioId ? { audioId } : {}), ...(audioSource ? { audioSource } : {}) });
    }
  }
  return selectAdmission(entries, maxMedia);
}

export class PromptMediaPreparation {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly timeoutError = new Error("本轮媒体准备已达到总等待期限");
  private readonly failures = new Set<string>();
  private currentAdmission: CurrentMediaAdmission | undefined;
  private historyAdmission: CurrentMediaAdmission | undefined;
  private readonly resolvedFiles = new Map<string, string>();

  constructor(readonly config: { timeoutMs: number; maxCurrentMedia: number; maxHistoryMedia: number }, private readonly callerSignal?: AbortSignal) {
    this.signal = this.controller.signal;
    if (callerSignal?.aborted) this.controller.abort(callerSignal.reason);
    else callerSignal?.addEventListener("abort", this.forwardAbort, { once: true });
    this.timer = setTimeout(() => this.controller.abort(this.timeoutError), config.timeoutMs);
  }

  private readonly forwardAbort = () => this.controller.abort(this.callerSignal?.reason);

  currentMedia(messages: readonly GenerationPromptBatchMessage[]): CurrentMediaAdmission {
    this.currentAdmission ??= admitCurrentPromptMedia(messages, this.config.maxCurrentMedia);
    return this.withResolvedFiles(this.currentAdmission);
  }

  historyMedia(history: readonly { content: string }[], replay: readonly LlmMessage[]): CurrentMediaAdmission {
    this.historyAdmission ??= admitHistoryPromptMedia(history, replay, this.config.maxHistoryMedia, this.currentAdmission);
    return this.withResolvedFiles(this.historyAdmission);
  }

  recordResolution(mediaRef: string, fileId: string): void {
    if (!this.signal.aborted && (this.currentAdmission?.mediaRefs.has(mediaRef) || this.historyAdmission?.mediaRefs.has(mediaRef))) {
      this.resolvedFiles.set(mediaRef, fileId);
    }
  }

  private withResolvedFiles(admission: CurrentMediaAdmission): CurrentMediaAdmission {
    return { ...admission, fileIds: new Set([...admission.fileIds, ...[...admission.mediaRefs]
      .flatMap(ref => this.resolvedFiles.has(ref) ? [this.resolvedFiles.get(ref)!] : [])]) };
  }

  finishMediaPreparation(): void {
    clearTimeout(this.timer);
  }

  /** 实际工作必须同时收到 signal。不可取消的本地只读操作迟到后仅丢弃结果，不得调度后续工作。 */
  async run<T>(work: (signal: AbortSignal) => Promise<T>, fallback: T, label: string): Promise<T> {
    this.callerSignal?.throwIfAborted();
    if (this.signal.aborted) return fallback;
    try {
      return await new Promise<T>((resolve, reject) => {
        const abort = () => { cleanup(); reject(this.signal.reason); };
        const cleanup = () => this.signal.removeEventListener("abort", abort);
        this.signal.addEventListener("abort", abort, { once: true });
        if (this.signal.aborted) { abort(); return; }
        Promise.resolve().then(() => {
          this.signal.throwIfAborted();
          return work(this.signal);
        }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      });
    } catch (error) {
      this.callerSignal?.throwIfAborted();
      if (error !== this.timeoutError && !this.signal.aborted) this.failures.add(label);
      return fallback;
    }
  }

  notes(): string[] {
    return [
      ...((this.currentAdmission?.omitted ?? 0) > 0 ? [`本轮当前输入有 ${this.currentAdmission!.omitted} 项媒体超过自动准备额度（最多 ${this.config.maxCurrentMedia} 项）；其文本和资源句柄仍保留，本轮未自动读取这些媒体。`] : []),
      ...((this.historyAdmission?.omitted ?? 0) > 0 ? [`选中历史有 ${this.historyAdmission!.omitted} 项媒体超过自动准备额度（最多 ${this.config.maxHistoryMedia} 项）；本轮保留其句柄，尚未自动恢复、描述或听写。`] : []),
      ...(this.signal.reason === this.timeoutError ? ["本轮媒体准备已到总等待期限；保留已就绪结果和资源句柄，缺少描述、听写或原生媒体输入的部分暂不可用，不要臆测其内容。"] : []),
      ...(this.failures.size ? [`部分媒体准备失败：${[...this.failures].join("、")}；保留引用，缺失内容暂不可用。`] : [])
    ];
  }

  dispose(): void {
    this.finishMediaPreparation();
    this.callerSignal?.removeEventListener("abort", this.forwardAbort);
  }
}

export async function withPromptMediaPreparation<T>(
  config: { timeoutMs: number; maxCurrentMedia: number; maxHistoryMedia: number },
  callerSignal: AbortSignal | undefined,
  work: (scope: PromptMediaPreparation) => Promise<T>
): Promise<T> {
  const scope = new PromptMediaPreparation(config, callerSignal);
  try { return await work(scope); }
  finally { scope.dispose(); }
}

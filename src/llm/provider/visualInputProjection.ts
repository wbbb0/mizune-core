import sharp from "sharp";
import type { AppConfig } from "#config/config.ts";
import { supportsNativeVideoInput, getNativeVideoInputLimits } from "#config/llmProviderDefinitions.ts";
import { encodeAnimatedVideo } from "#services/workspace/animatedVideo.ts";
import { normalizeAnimatedDurationMs, selectAnimatedFrameIndexes, serializeAnimatedStoryboard } from "#services/workspace/visualInputSerialization.ts";
import type { LlmContentPart, LlmMessage, LlmProviderRequestContext } from "./providerTypes.ts";

/** 缓存仅活在一次请求内。保留规范消息，使备用模型能独立选择视频或拼图。 */
export function createVisualInputProjector(config: AppConfig) {
  const cache = new Map<string, Promise<LlmContentPart>>();
  return async (messages: LlmMessage[], context: LlmProviderRequestContext, signal?: AbortSignal): Promise<LlmMessage[]> => {
    const nativeVideo = supportsNativeVideoInput(context.providerConfig.type)
      && context.modelProfile.chat?.capabilities.supportsVideoInput === true;
    const projected: LlmMessage[] = [];
    // 顺序处理，避免一批动图同时启动多个 ffmpeg 或解码整批动画。
    for (const message of messages) {
      signal?.throwIfAborted();
      if (!Array.isArray(message.content)) { projected.push(message); continue; }
      const content: LlmContentPart[] = [];
      for (const part of message.content) {
        if (part.type === "video_url" && !nativeVideo) throw new Error("目标模型或供应商未声明支持原生视频输入");
        if (part.type !== "image_url" || !/^data:image\/(gif|webp|png);base64,/.test(part.image_url.url)) {
          content.push(part);
          continue;
        }
        const key = `${nativeVideo}:${part.image_url.url}`;
        let pending = cache.get(key);
        if (!pending) {
          pending = projectAnimatedImage(part, nativeVideo, config, context, signal);
          cache.set(key, pending);
        }
        content.push(await pending);
      }
      projected.push({ ...message, content });
    }
    return projected;
  };
}

async function projectAnimatedImage(part: Extract<LlmContentPart, { type: "image_url" }>, nativeVideo: boolean,
  config: AppConfig, context: LlmProviderRequestContext, signal?: AbortSignal): Promise<LlmContentPart> {
  signal?.throwIfAborted();
  const buffer = Buffer.from(part.image_url.url.slice(part.image_url.url.indexOf(",") + 1), "base64");
  // 上游模型仍负责诊断无效图片；占位 URL 不能破坏原有的非动图请求。
  const metadata = await sharp(buffer, { animated: true }).metadata().catch(() => null);
  if (!metadata) return part;
  const pages = metadata.pages ?? 1;
  if (pages <= 1) return part;
  const durationMs = normalizeAnimatedDurationMs(metadata.delay, pages);
  // 避免解码超大动画导致内存耗尽；超限继续使用逐帧采样，不裁掉原动画冒充完整视频。
  const limits = getNativeVideoInputLimits(context.providerConfig.type);
  const pixels = (metadata.width ?? 1) * (metadata.pageHeight ?? metadata.height ?? 1) * pages;
  if (nativeVideo && pages >= limits.minFrames && pages <= 512 && pixels <= 128 * 1024 * 1024 && durationMs > 0 && durationMs >= limits.minDurationMs && durationMs <= 120000) {
    try {
      const video = await encodeAnimatedVideo(buffer, Math.min(config.chatFiles.maxUploadBytes, limits.maxBytes), config.conversation.images.maxSerializedPixels, signal);
      const delays = (metadata.delay ?? []).filter(delay => delay > 0);
      const fps = Math.min(10, Math.max(1, 1000 / Math.min(...delays, 1000)));
      return { type: "video_url", video_url: { url: `data:video/mp4;base64,${video.toString("base64")}` }, durationMs, fps };
    } catch {
      signal?.throwIfAborted();
      context.logger.warn({ modelRef: context.modelRef }, "animated_video_conversion_failed_using_storyboard");
    }
  }
  signal?.throwIfAborted();
  const indexes = selectAnimatedFrameIndexes(pages, durationMs);
  return { type: "image_url", image_url: { url: await serializeAnimatedStoryboard(buffer, metadata, indexes, config.conversation.images.maxSerializedPixels) } };
}

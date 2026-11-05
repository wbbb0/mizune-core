import sharp from "sharp";
import type { AppConfig } from "#config/config.ts";
import { supportsStandardImageGeneration } from "#config/llmProviderDefinitions.ts";
import { resolveModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { withProviderExchangeDump } from "#llm/provider/providerExchangeDump.ts";
import { buildImageRequestParameters } from "./imageRequestParameters.ts";
import { requestOpenAiImage } from "./openAiImageProvider.ts";
import { requestGoogleImage } from "./googleImageProvider.ts";
import type { GeneratedImage, GenerateImageInput } from "./imageGenerationTypes.ts";
export type { GeneratedImage } from "./imageGenerationTypes.ts";

function resolveImageModel(config: AppConfig, editing = false) {
  for (const modelRef of resolveModelRefsForRole(config, "image_generator").acceptedModelRefs) {
    const profile = config.llm.models[modelRef];
    const provider = profile ? config.llm.providers[profile.provider] : undefined;
    if (profile && provider && supportsStandardImageGeneration(provider.type)
      && (!editing || (provider.type !== "openrouter" && profile.image?.capabilities.referenceImages === true))) {
      return { modelRef, profile, provider };
    }
  }
  return null;
}

export function isImageGenerationAvailable(config: AppConfig): boolean {
  return config.llm.enabled && config.llm.imageGeneration.enabled && config.chatFiles.enabled && resolveImageModel(config) !== null;
}

/** 一次调用只生成一张图片，不自动重试或切换模型，以免重复生成及计费。 */
export async function generateConfiguredImage(config: AppConfig, input: GenerateImageInput): Promise<GeneratedImage> {
  if (!isImageGenerationAvailable(config)) throw new Error("图像生成未启用，或未配置支持图像生成的路由");
  const editing = (input.referenceImages?.length ?? 0) > 0;
  if (input.mask && !editing) throw new Error("局部编辑蒙版必须与参考图一起提供");
  const target = resolveImageModel(config, editing);
  if (!target) throw new Error("未配置声明支持参考图编辑的图像模型");
  const maxReferences = target.profile.image?.constraints.maxReferenceImages;
  if (maxReferences !== undefined && (input.referenceImages?.length ?? 0) > maxReferences) {
    throw new Error(`参考图数量超过模型限制 ${maxReferences}`);
  }
  return withProviderExchangeDump({ config, modelRef: target.modelRef, model: target.profile.model, ...(input.logger ? { logger: input.logger } : {}) }, input.skipDebugDump, async () => {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("图片描述不能为空");
    const settings = buildImageRequestParameters(target.profile, target.provider, input.size?.trim(), editing, {
      ...(input.quality?.trim() ? { quality: input.quality.trim() } : {}),
      ...(input.aspectRatio?.trim() ? { aspect_ratio: input.aspectRatio.trim() } : {}),
      ...(input.resolution?.trim() ? { resolution: input.resolution.trim() } : {}),
      ...(input.outputFormat !== undefined ? { output_format: input.outputFormat } : {}),
      ...(input.frameCount !== undefined ? { frame_count: input.frameCount } : {}),
      ...(input.frameDurationMs !== undefined ? { frame_duration_ms: input.frameDurationMs } : {})
    });
    const signal = AbortSignal.any([AbortSignal.timeout(config.llm.imageGeneration.timeoutMs), ...(input.abortSignal ? [input.abortSignal] : [])]);
    signal.throwIfAborted();
    const output = await (target.provider.type === "google" ? requestGoogleImage : requestOpenAiImage)({ config, target, input, prompt, settings, signal });
    signal.throwIfAborted();
    const maxBytes = config.chatFiles.maxUploadBytes;
    if (!output.buffer.length || output.buffer.length > maxBytes) throw new Error("生成图片为空或超过资产大小限制");
    const metadata = await sharp(output.buffer, { animated: true }).metadata();
    const format = metadata.format;
    if (!format || !["png", "jpeg", "webp", "gif"].includes(format) || !metadata.width || !metadata.height) throw new Error("图像生成接口未返回有效的 PNG、JPEG、WebP 或 GIF 图片");
    if (target.provider.type === "google" && (format === "gif" || (metadata.pages ?? 1) > 1)) throw new Error("Google 原生图像输出必须是静态图片");
    signal.throwIfAborted();
    return {
      ...output, mimeType: `image/${format}`, extension: format === "jpeg" ? "jpg" : format,
      width: metadata.width, height: metadata.pageHeight ?? metadata.height, modelRef: target.modelRef
    };
  }, "image");
}

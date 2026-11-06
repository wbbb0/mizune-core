import { getRequestDiagnostic } from "#llm/provider/requestDiagnostics.ts";
import { ImageGenerationError } from "#services/images/imageGenerationError.ts";
import { generateConfiguredImage, isImageGenerationAvailable } from "#services/images/imageGeneration.ts";
import { buildChatFileHandleResultFromContext } from "../core/chatFileHandle.ts";
import { chatFileListPolicy } from "../core/resultObservationPresets.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg, getNumberArg } from "../core/toolArgHelpers.ts";
import { parseReferenceImageSelectors, resolveStaticImageAsset } from "../core/imageAssetReferences.ts";
import { readFile, stat } from "node:fs/promises";
import type { ImageEditSource } from "#services/images/imageEditInputs.ts";

export const imageGenerationToolDescriptors: ToolDescriptor[] = [{
  modelPolicy: { kind: "bounded_content" },
  definition: {
    type: "function",
    function: {
      name: "generate_image",
      description: "通过已配置的图像接口生成静态图片、GIF 动图或编辑一张静态图片，等待完成并返回可发送的图片资产。描述用中文；编辑时用 reference_images 指定已有图片资产，需要局部重绘时提供带透明区域的 mask_image 蒙版资产。GIF 动图仅支持新生成，不能同时提供参考图或蒙版。不要用于下载已有图片。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "完整的图片描述。" },
          size: { type: "string", description: "可选像素尺寸，例如 1024x1024；用于支持 size 的 Images 接口。Google 使用 aspect_ratio/resolution，不传 size。" },
          aspect_ratio: { type: "string", description: "可选图片比例，如 1:1、16:9；仅 Google 原生图像或 OpenRouter 使用，必须属于模型支持的比例。" },
          resolution: { type: "string", description: "可选图片分辨率，如 1K、2K、4K；仅 Google 原生图像或 OpenRouter 使用。" },
          quality: { type: "string", description: "可选画质，例如 low、medium、high；仅限支持 quality 的接口。Google 不接收此字段，使用 resolution。" },
          output_format: { type: "string", enum: ["png", "jpeg", "webp", "gif"], description: "可选输出格式；仅支持该参数的接口可用。Google 使用上游实际图片格式，不传此字段。需要动图时选择 gif。" },
          frame_count: { type: "integer", minimum: 2, maximum: 64, description: "GIF 帧数，省略使用模型默认值。" },
          frame_duration_ms: { type: "integer", minimum: 20, maximum: 2000, description: "GIF 每帧时长（毫秒），按 10 毫秒取整；仅用于 GIF。" },
          reference_images: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16, description: "编辑所用参考图片的 asset_ref 或 file_id；必须是已导入的静态图片资产。省略时生成新图。" },
          mask_image: { type: "string", description: "可选局部重绘蒙版资产，必须为有透明区域的 PNG，与第一张参考图尺寸一致。透明区域表示编辑位置；Google 原生图像暂不支持独立蒙版参数。" }
        },
        required: ["prompt"],
        additionalProperties: false
      }
    }
  },
  isEnabled: isImageGenerationAvailable,
  resultObservation: chatFileListPolicy()
}];

export const imageGenerationToolHandlers: Record<string, ToolHandler> = {
  async generate_image(_call, args, context) {
    try {
      const references = parseReferenceImageSelectors((args as Record<string, unknown>)?.reference_images);
      const referenceImages: ImageEditSource[] = [];
      let inputBytes = 0;
      for (const selector of references) {
        const image = await readImageAsset(context, selector, context.config.chatFiles.maxUploadBytes - inputBytes);
        referenceImages.push(image);
        inputBytes += image.buffer.length;
      }
      const maskSelector = getStringArg(args, "mask_image");
      if (maskSelector && references.length === 0) throw new Error("蒙版必须与参考图一起提供");
      const mask = maskSelector ? await readImageAsset(context, maskSelector, context.config.chatFiles.maxUploadBytes - inputBytes) : undefined;
      const image = await generateConfiguredImage(context.config, {
        prompt: getStringArg(args, "prompt"),
        ...(getStringArg(args, "aspect_ratio") ? { aspectRatio: getStringArg(args, "aspect_ratio") } : {}),
        ...(getStringArg(args, "resolution") ? { resolution: getStringArg(args, "resolution") } : {}),
        ...(getStringArg(args, "quality") ? { quality: getStringArg(args, "quality") } : {}),
        ...(getStringArg(args, "output_format") ? { outputFormat: getStringArg(args, "output_format") } : {}),
        ...(getNumberArg(args, "frame_count") !== undefined ? { frameCount: getNumberArg(args, "frame_count")! } : {}),
        ...(getNumberArg(args, "frame_duration_ms") !== undefined ? { frameDurationMs: getNumberArg(args, "frame_duration_ms")! } : {}),
        ...(getStringArg(args, "size") ? { size: getStringArg(args, "size") } : {}),
        ...(referenceImages.length ? { referenceImages } : {}),
        ...(mask ? { mask } : {}),
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
      });
      context.abortSignal?.throwIfAborted();
      const stored = await context.chatFileStore.importBuffer({
        buffer: image.buffer,
        sourceName: `generated.${image.extension}`,
        mimeType: image.mimeType,
        kind: "image",
        origin: "image_generated",
        sourceContext: { tool: "generate_image", modelRef: image.modelRef, ...(references.length ? { referenceImages: references.join(",") } : {}) }
      });
      const file = buildChatFileHandleResultFromContext(stored, context);
      return JSON.stringify({
        ok: true,
        model_ref: image.modelRef,
        asset_ref: stored.fileRef,
        file_id: stored.fileId,
        width: image.width,
        height: image.height,
        ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
        file,
        asset_handle: file.asset_handle,
        next_actions: file.next_actions ?? []
      });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ImageGenerationError ? { detail: { ...error.details, ...(getRequestDiagnostic(error) ? { requestDiagnostic: getRequestDiagnostic(error) } : {}) } } : getRequestDiagnostic(error) ? { detail: { requestDiagnostic: getRequestDiagnostic(error) } } : {}) });
    }
  }
};

async function readImageAsset(context: Parameters<ToolHandler>[2], selector: string, maxBytes: number): Promise<ImageEditSource> {
  context.abortSignal?.throwIfAborted();
  const file = await resolveStaticImageAsset(context, selector);
  const absolutePath = await context.chatFileStore.resolveAbsolutePath(file.fileId);
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size > maxBytes) throw new Error("参考图总大小超过资产大小限制");
  const buffer = await readFile(absolutePath);
  if (buffer.length > maxBytes) throw new Error("参考图总大小超过资产大小限制");
  context.abortSignal?.throwIfAborted();
  return { buffer };
}

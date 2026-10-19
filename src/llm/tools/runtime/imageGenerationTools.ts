import { generateConfiguredImage, isImageGenerationAvailable } from "#services/images/imageGeneration.ts";
import { buildChatFileHandleResultFromContext } from "../core/chatFileHandle.ts";
import { chatFileListPolicy } from "../core/resultObservationPresets.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";

export const imageGenerationToolDescriptors: ToolDescriptor[] = [{
  definition: {
    type: "function",
    function: {
      name: "generate_image",
      description: "通过已配置的标准图像生成接口生成一张新图片，等待完成并返回可发送的图片资产。描述用中文，完整说明画面内容和风格；不要用于下载已有图片。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "完整的图片描述。" },
          size: { type: "string", description: "可选尺寸，例如 1024x1024；省略使用配置默认值，必须是供应商支持的尺寸。" }
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
      const image = await generateConfiguredImage(context.config, {
        prompt: getStringArg(args, "prompt"),
        ...(getStringArg(args, "size") ? { size: getStringArg(args, "size") } : {}),
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
      });
      context.abortSignal?.throwIfAborted();
      const stored = await context.chatFileStore.importBuffer({
        buffer: image.buffer,
        sourceName: `generated.${image.extension}`,
        mimeType: image.mimeType,
        kind: "image",
        origin: "image_generated",
        sourceContext: { tool: "generate_image", modelRef: image.modelRef }
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
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
};

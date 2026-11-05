import type { Part } from "@google/genai";
import { runAiStudioOperation } from "#llm/provider/providers/googleSdkOperation.ts";
import { LlmProviderHttpError } from "#llm/provider/providerProtocolError.ts";
import { ImageGenerationError, imageApiFailure, imageTransportFailure } from "./imageGenerationError.ts";
import { validateImageSources } from "./imageEditInputs.ts";
import { decodeImageBase64 } from "./imageOutput.ts";
import type { GeneratedImageBytes, ImageProtocolRequest } from "./imageGenerationTypes.ts";

export async function requestGoogleImage({ config, target, input, prompt, settings, signal }: ImageProtocolRequest): Promise<GeneratedImageBytes> {
  if (input.mask) throw new Error("Google 原生图像暂不支持独立蒙版参数，请通过参考图与文字描述编辑");
  const references = input.referenceImages ?? [];
  if (references.length > 16) throw new Error("参考图数量超过协议限制 16");
  const metadata = await validateImageSources(references, config.chatFiles.maxUploadBytes);
  signal.throwIfAborted();
  const parts: Part[] = [{ text: prompt }, ...references.map((source, index) => ({ inlineData: { mimeType: `image/${metadata[index]!.format}`, data: source.buffer.toString("base64") } }))];
  const protocolError = (message: string) => new ImageGenerationError({ stage: "request", kind: "protocol", modelRef: target.modelRef, message });
  try {
    return await runAiStudioOperation({
      config, providerConfig: target.provider, baseUrl: target.provider.baseUrl, modelRef: target.modelRef, signal,
      maxResponseBytes: Math.ceil(config.chatFiles.maxUploadBytes / 3) * 4 + 65536
    }, async (client, signal) => {
      const response = await client.models.generateContent({
        model: target.profile.model, contents: [{ role: "user", parts }], config: {
          abortSignal: signal, store: false, automaticContinuation: false, automaticFunctionCalling: { disable: true },
          responseModalities: ["IMAGE"],
          imageConfig: {
            ...(settings.aspect_ratio ? { aspectRatio: String(settings.aspect_ratio) } : {}),
            ...(settings.resolution ? { imageSize: String(settings.resolution) } : {})
          }
        }
      });
      if (response.promptFeedback?.blockReason) throw protocolError(`Google 拒绝生成图片：${response.promptFeedback.blockReason}`);
      const candidate = response.candidates?.[0];
      if (response.candidates?.length !== 1 || candidate?.finishReason !== "STOP") throw protocolError(`Google 图像生成未正常完成：${candidate?.finishReason ?? "缺少终态"}`);
      const images = candidate.content?.parts?.filter(part => part.thought !== true && part.inlineData) ?? [];
      if (images.length !== 1) throw protocolError("Google 图像接口未返回一张最终图片");
      const data = images[0]!.inlineData;
      if (!data?.data || !["image/png", "image/jpeg", "image/webp"].includes(data.mimeType ?? "")) throw protocolError("Google 未返回有效的图片数据或 MIME 类型");
      try { return { buffer: decodeImageBase64(data.data, config.chatFiles.maxUploadBytes) }; }
      catch (error) { throw protocolError(error instanceof Error ? error.message : "Google 图片数据无效"); }
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImageGenerationError) throw error;
    const secrets = [target.provider.apiKey ?? ""];
    if (error instanceof LlmProviderHttpError) throw imageApiFailure(error.message, "request", target.modelRef, error.statusCode, secrets);
    throw imageTransportFailure(error, "request", target.modelRef, secrets);
  }
}

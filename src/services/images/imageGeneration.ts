import { buildImageRequestParameters } from "./imageRequestParameters.ts";
import { fetchProviderResponse, withProviderExchangeDump } from "#llm/provider/providerExchangeDump.ts";
import { supportsStandardImageGeneration } from "#config/llmProviderDefinitions.ts";
import sharp from "sharp";
import type { AppConfig } from "#config/config.ts";
import { resolveModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { fetchWithProxy } from "#services/proxy/index.ts";

function resolveImageModel(config: AppConfig) {
  for (const modelRef of resolveModelRefsForRole(config, "image_generator").acceptedModelRefs) {
    const profile = config.llm.models[modelRef];
    const provider = profile ? config.llm.providers[profile.provider] : undefined;
    if (profile && provider && supportsStandardImageGeneration(provider.type)) return { modelRef, profile, provider };
  }
  return null;
}

export function isImageGenerationAvailable(config: AppConfig): boolean {
  return config.llm.enabled && config.llm.imageGeneration.enabled && config.chatFiles.enabled
    && resolveImageModel(config) !== null;
}

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  modelRef: string;
  revisedPrompt?: string;
}

/** 一次调用只生成一张图片，不自动重试或切换模型，以免重复生成及计费。 */
export async function generateConfiguredImage(config: AppConfig, input: {
  prompt: string;
  size?: string;
  abortSignal?: AbortSignal;
}): Promise<GeneratedImage> {
  if (!isImageGenerationAvailable(config)) throw new Error("图像生成未启用，或未配置支持标准 Images API 的生图路由");
  const target = resolveImageModel(config)!;
  return withProviderExchangeDump({ config, modelRef: target.modelRef, model: target.profile.model }, false, async () => {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("图片描述不能为空");
    const settings = buildImageRequestParameters(target.profile, target.provider, input.size?.trim());
    const signal = AbortSignal.any([
      AbortSignal.timeout(config.llm.imageGeneration.timeoutMs),
      ...(input.abortSignal ? [input.abortSignal] : [])
    ]);
    signal.throwIfAborted();
    const baseUrl = (target.provider.baseUrl ?? (target.provider.type === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).replace(/\/+$/, "");
    const response = await fetchProviderResponse(config, "llm", `${baseUrl}${target.provider.type === "openrouter" ? "/images" : "/images/generations"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.provider.apiKey ? { Authorization: `Bearer ${target.provider.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: target.profile.model,
        prompt,
        n: 1,
        ...settings
      }),
      signal
    }, { modelRef: target.modelRef });
    if (!response.ok) {
      let detail: string;
      try {
        detail = (await readBoundedBody(response, 65536)).toString("utf8");
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      throw new Error(`图像生成接口返回 HTTP ${response.status}（${target.modelRef}）：${detail.slice(0, 4096)}`);
    }
    const maxBytes = config.chatFiles.maxUploadBytes;
    const payload = JSON.parse((await readBoundedBody(response, Math.ceil(maxBytes * 4 / 3) + 65536)).toString("utf8")) as {
      data?: Array<{ b64_json?: unknown; url?: unknown; revised_prompt?: unknown }>;
    };
    if (!Array.isArray(payload.data) || payload.data.length !== 1) {
      throw new Error("图像生成接口未返回一张图片");
    }
    const row = payload.data[0]!;
    let buffer: Buffer;
    if (typeof row.b64_json === "string" && row.b64_json.length > 0) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(row.b64_json) || row.b64_json.length % 4 !== 0) {
        throw new Error("图像生成接口返回了无效的 Base64 图片");
      }
      buffer = Buffer.from(row.b64_json, "base64");
    } else if (typeof row.url === "string") {
      const url = new URL(row.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("图像生成接口返回了无效的图片 URL");
      }
      // 图片存储地址可以不同于 API 域名，绝不转发供应商凭据。
      const imageResponse = await fetchWithProxy(config, "llm", url.href, { signal }, { modelRef: target.modelRef });
      if (!imageResponse.ok) {
        await imageResponse.body?.cancel();
        throw new Error(`生成图片下载失败：HTTP ${imageResponse.status}`);
      }
      buffer = await readBoundedBody(imageResponse, maxBytes);
    } else {
      throw new Error("图像生成接口缺少 b64_json 或 url");
    }
    signal.throwIfAborted();
    if (!buffer.length || buffer.length > maxBytes) throw new Error("生成图片为空或超过资产大小限制");
    const metadata = await sharp(buffer).metadata();
    const format = metadata.format;
    if (!format || !["png", "jpeg", "webp"].includes(format) || !metadata.width || !metadata.height) {
      throw new Error("图像生成接口未返回有效的 PNG、JPEG 或 WebP 图片");
    }
    return {
      buffer,
      mimeType: `image/${format}`,
      extension: format === "jpeg" ? "jpg" : format,
      width: metadata.width,
      height: metadata.height,
      modelRef: target.modelRef,
      ...(typeof row.revised_prompt === "string" ? { revisedPrompt: row.revised_prompt } : {})
    };
  }, "image");
}

async function readBoundedBody(response: Awaited<ReturnType<typeof fetchWithProxy>>, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("图像接口响应超过大小限制");
  }
  if (!response.body) throw new Error("图像接口响应为空");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("图像接口响应超过大小限制");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

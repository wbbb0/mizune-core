import { fetchProviderResponse } from "#llm/provider/providerExchangeDump.ts";
import { readBoundedProviderBody } from "#llm/provider/providerResponseBody.ts";
import { fetchWithProxy } from "#services/proxy/index.ts";
import { ImageGenerationError, imageApiFailure, imageTransportFailure } from "./imageGenerationError.ts";
import { buildImageEditBody } from "./imageEditInputs.ts";
import { decodeImageBase64 } from "./imageOutput.ts";
import type { GeneratedImageBytes, ImageProtocolRequest } from "./imageGenerationTypes.ts";

export async function requestOpenAiImage({ config, target, input, prompt, settings, signal }: ImageProtocolRequest): Promise<GeneratedImageBytes> {
  const editing = (input.referenceImages?.length ?? 0) > 0;
  const request = editing
    ? await buildImageEditBody({
        model: target.profile.model, prompt, settings,
        images: input.referenceImages!,
        ...(input.mask ? { mask: input.mask } : {}),
        maxBytes: config.chatFiles.maxUploadBytes
      })
    : JSON.stringify({ model: target.profile.model, prompt, n: 1, ...settings });
  signal.throwIfAborted();
  const baseUrl = (target.provider.baseUrl ?? (target.provider.type === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).replace(/\/+$/, "");
  const endpoint = editing ? "/images/edits" : target.provider.type === "openrouter" ? "/images" : "/images/generations";
  const secrets = Object.values(config.llm.providers).map(provider => provider.apiKey ?? "");
  const response = await fetchProviderResponse(config, "llm", `${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      ...(editing ? {} : { "Content-Type": "application/json" }),
      ...(target.provider.apiKey ? { Authorization: `Bearer ${target.provider.apiKey}` } : {})
    },
    body: request,
    signal
  }, { modelRef: target.modelRef }).catch(error => {
    signal.throwIfAborted();
    throw imageTransportFailure(error, "request", target.modelRef, secrets);
  });
  if (!response.ok) {
    let detail: string;
    try {
      detail = (await readBoundedProviderBody(response, 65536)).toString("utf8");
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    throw imageApiFailure(detail, "request", target.modelRef, response.status, secrets);
  }
  const maxBytes = config.chatFiles.maxUploadBytes;
  const body = await readBoundedProviderBody(response, Math.ceil(maxBytes * 4 / 3) + 65536).catch(error => {
    signal.throwIfAborted();
    throw imageTransportFailure(error, "request", target.modelRef, secrets);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); }
  catch { throw new ImageGenerationError({ stage: "request", kind: "protocol", modelRef: target.modelRef, httpStatus: response.status, message: "接口返回了无效的 JSON 响应" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ImageGenerationError({ stage: "request", kind: "protocol", modelRef: target.modelRef, httpStatus: response.status, message: "接口响应不是有效对象" });
  }
  const payload = parsed as {
    error?: unknown;
    data?: Array<{ b64_json?: unknown; url?: unknown; revised_prompt?: unknown }>;
  };
  if (payload.error != null) {
    throw imageApiFailure(JSON.stringify({ error: payload.error }), "request", target.modelRef, response.status, secrets);
  }
  if (!Array.isArray(payload.data) || payload.data.length !== 1) {
    throw new Error("图像生成接口未返回一张图片");
  }
  const row = payload.data[0]!;
  let buffer: Buffer;
  if (typeof row.b64_json === "string" && row.b64_json.length > 0) {
    buffer = decodeImageBase64(row.b64_json, maxBytes);
  } else if (typeof row.url === "string") {
    const url = new URL(row.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("图像生成接口返回了无效的图片 URL");
    }
    // 图片存储地址可以不同于 API 域名，绝不转发供应商凭据。
    const imageResponse = await fetchWithProxy(config, "llm", url.href, { signal }, { modelRef: target.modelRef }).catch(error => {
      signal.throwIfAborted();
      throw imageTransportFailure(error, "download", target.modelRef, secrets);
    });
    if (!imageResponse.ok) {
      let detail: string;
      try { detail = (await readBoundedProviderBody(imageResponse, 65536)).toString("utf8"); }
      catch { detail = "无法读取下载错误说明"; }
      throw imageApiFailure(detail, "download", target.modelRef, imageResponse.status, secrets);
    }
    buffer = await readBoundedProviderBody(imageResponse, maxBytes).catch(error => {
      signal.throwIfAborted();
      throw imageTransportFailure(error, "download", target.modelRef, secrets);
    });
  } else {
    throw new Error("图像生成接口缺少 b64_json 或 url");
  }
  return { buffer, ...(typeof row.revised_prompt === "string" ? { revisedPrompt: row.revised_prompt } : {}) };
}

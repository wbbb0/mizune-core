import { File } from "node:buffer";
import { FormData } from "undici";
import type { LlmProviderRequestContext } from "./providerTypes.ts";
import type { LlmTranscribeParams, LlmTranscribeResult, LlmSynthesizeParams, LlmSynthesizeResult, SpeechFormat } from "./nativeCapabilityTypes.ts";
import { isObject, nativeUsage, readNativeBody, requestNativeCapability } from "./nativeCapabilityHttp.ts";

const audioTypes: Record<SpeechFormat, { mimeType: string; extension: string }> = {
  mp3: { mimeType: "audio/mpeg", extension: "mp3" },
  opus: { mimeType: "audio/ogg", extension: "ogg" },
  aac: { mimeType: "audio/aac", extension: "aac" },
  flac: { mimeType: "audio/flac", extension: "flac" },
  wav: { mimeType: "audio/wav", extension: "wav" }
};

export async function requestOpenAiTranscription(context: LlmProviderRequestContext, params: LlmTranscribeParams): Promise<LlmTranscribeResult> {
  const settings = context.modelProfile.transcription;
  if (!settings) throw new Error("模型未配置转写用途");
  const format = params.audio.format.toLowerCase().replace(/^\./, "");
  if (!["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"].includes(format)) throw new Error(`OpenAI 原生转写不支持音频格式 ${format}`);
  if (!params.audio.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.audio.data) || params.audio.data.length % 4 !== 0) throw new Error("转写音频不是有效 Base64");
  const buffer = Buffer.from(params.audio.data, "base64");
  if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new Error("转写音频为空或超过 25 MiB 限制");
  const form = new FormData();
  form.set("file", new File([buffer], `audio.${format}`, { type: params.audio.mimeType ?? "application/octet-stream" }));
  form.set("model", context.model);
  form.set("response_format", "json");
  const language = params.language ?? settings.language;
  const prompt = params.prompt ?? settings.prompt;
  if (language) form.set("language", language);
  if (prompt) form.set("prompt", prompt);
  return requestNativeCapability(context, params, "/audio/transcriptions", { body: form }, async response => {
    const payload: unknown = JSON.parse((await readNativeBody(response, 2 * 1024 * 1024)).toString("utf8"));
    if (!isObject(payload) || typeof payload.text !== "string") throw new Error("OpenAI 转写响应缺少 text");
    return { text: payload.text, usage: nativeUsage(context, payload.usage) };
  });
}

/** Speech creation is charged per request: no retries or fallback after transmission. */
export async function requestOpenAiSpeech(context: LlmProviderRequestContext, params: LlmSynthesizeParams): Promise<LlmSynthesizeResult> {
  const settings = context.modelProfile.speech;
  if (!settings) throw new Error("模型未配置语音生成用途");
  const text = params.text.trim();
  if (!text || text.length > 4096) throw new Error("语音文本长度须为 1–4096 个字符");
  const format = params.format ?? settings.format;
  const voice = params.voice?.trim() || settings.voice;
  const speed = params.speed ?? settings.speed;
  const instructions = params.instructions ?? settings.instructions;
  if (!audioTypes[format]) throw new Error("不支持的语音输出格式");
  if (!voice) throw new Error("未配置语音音色");
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error("语音速度须在 0.25–4 之间");
  if (instructions && instructions.length > 4096) throw new Error("语音风格说明不能超过 4096 个字符");
  return requestNativeCapability(context, params, "/audio/speech", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: context.model, input: text, voice, response_format: format, speed, ...(instructions ? { instructions } : {}) })
  }, async response => {
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new Error("OpenAI 语音接口未返回音频");
    const buffer = await readNativeBody(response, context.config.chatFiles.maxUploadBytes);
    if (!buffer.length) throw new Error("OpenAI 语音接口返回空音频");
    return { buffer, ...audioTypes[format], usage: nativeUsage(context, undefined) };
  });
}

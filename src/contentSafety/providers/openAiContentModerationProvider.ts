import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import type { AppConfig } from "#config/config.ts";
import type { OpenAiContentSafetyProviderConfig } from "#config/contentSafetyConfig.ts";
import { fetchWithProxy } from "#services/proxy/index.ts";
import type { ContentModerationProvider, ModerateMediaInput, ModerationLabel, ModerationResult } from "../contentSafetyTypes.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const imageMimeTypes: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const responseSchema = z.object({
  id: z.string().min(1),
  results: z.array(z.object({
    flagged: z.boolean(),
    categories: z.record(z.string(), z.boolean().nullable()),
    category_scores: z.record(z.string(), z.number().min(0).max(1))
  })).length(1)
});

type ModerationInput = string | Array<{ type: "image_url"; image_url: { url: string } }>;

export function createOpenAiContentModerationProvider(
  id: string,
  provider: OpenAiContentSafetyProviderConfig,
  config: AppConfig
): ContentModerationProvider {
  async function request(input: ModerationInput, signal: AbortSignal): Promise<ModerationResult> {
    const apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv];
    if (!apiKey?.trim()) throw new Error("OpenAI 内容安全缺少 API Key");
    signal.throwIfAborted();
    let response;
    try {
      response = await fetchWithProxy(config, "llm", `${provider.baseUrl.replace(/\/+$/, "")}/moderations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: provider.model, input }),
        signal
      }, { providerProxy: provider.proxy });
    } catch {
      throw new Error(signal.aborted ? "OpenAI 内容安全请求已取消或超时" : "OpenAI 内容安全请求失败");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // 不把上游正文、请求内容或凭据带入日志。
      throw new Error(`OpenAI 内容安全接口返回 HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = responseSchema.parse(await response.json());
    } catch {
      throw new Error("OpenAI 内容安全返回了无效审核结果");
    }
    signal.throwIfAborted();
    const verdict = payload.results[0]!;
    const flaggedCategories = Object.keys(verdict.categories).filter(category => verdict.categories[category] === true);
    const labels: ModerationLabel[] = Array.from(new Set([...Object.keys(verdict.category_scores), ...flaggedCategories]))
      .filter(category => verdict.categories[category] === true || (verdict.category_scores[category] ?? 0) > 0)
      .map(category => ({
        label: category,
        category,
        riskLevel: verdict.categories[category] === true ? "high" : "none",
        ...(verdict.category_scores[category] !== undefined ? { confidence: verdict.category_scores[category]! * 100 } : {})
      }));
    if (verdict.flagged && flaggedCategories.length === 0) {
      labels.push({ label: "openai_flagged", riskLevel: "high" });
    }
    const blocked = verdict.flagged || flaggedCategories.length > 0;
    return {
      decision: blocked ? "block" : "allow",
      reason: blocked ? `命中 OpenAI 内容安全标签：${flaggedCategories.join("、") || "flagged"}` : "allowed",
      labels,
      providerId: id,
      providerType: "openai_moderation",
      requestId: response.headers.get("x-request-id") ?? payload.id,
      rawDecision: blocked ? "flagged" : "not_flagged",
      checkedAtMs: Date.now()
    };
  }
  function makeSignal(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(provider.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  return {
    id,
    type: "openai_moderation",
    capabilities: new Set(["text", "audio_transcript", "image", "emoji", "local_media"]),
    async moderateText(input) {
      return request(input.text, makeSignal(input.abortSignal));
    },
    async moderateMedia(input) {
      const signal = makeSignal(input.abortSignal);
      const url = await resolveImageInput(input, signal);
      return request([{ type: "image_url", image_url: { url } }], signal);
    }
  };
}

async function resolveImageInput(input: ModerateMediaInput, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (input.subjectKind === "audio" || input.subjectKind === "file" || (input.mimeType && !input.mimeType.startsWith("image/"))) {
    throw new Error("OpenAI 内容安全仅支持文本和图片；音频需先转写后按文本审核");
  }
  if (!input.absolutePath) throw new Error("OpenAI 图片审核缺少本地路径或公开图片 URL");
  if (/^https?:\/\//i.test(input.absolutePath)) return input.absolutePath;
  try {
    const info = await stat(input.absolutePath);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("unsupported_image");
    const buffer = await readFile(input.absolutePath, { signal });
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("unsupported_image");
    const metadata = await sharp(buffer).metadata();
    const mimeType = imageMimeTypes[metadata.format ?? ""];
    if (!mimeType || (metadata.pages ?? 1) > 1) throw new Error("unsupported_image");
    signal.throwIfAborted();
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    throw new Error("OpenAI 图片审核需要不超过 20 MB 的 PNG、JPEG、WEBP 或静态 GIF");
  }
}

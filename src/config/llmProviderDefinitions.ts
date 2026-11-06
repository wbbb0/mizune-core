/** 供应商协议能力的单一目录；界面和运行时共用，不根据供应商别名猜测能力。 */
export const llmProviderTypes = ["openai_compatible", "openai", "openrouter", "openai_responses_compatible", "deepseek", "google", "vertex", "vertex_express", "dashscope", "lmstudio", "anthropic"] as const;
export type LlmProviderType = typeof llmProviderTypes[number];
export const llmProviderDefinitions = {
  openai: { decision: true, title: "OpenAI 官方", search: "native", googleSafety: false, customFeatures: false },
  openrouter: { decision: true, title: "OpenRouter", search: "none", googleSafety: false, customFeatures: false },
  openai_compatible: { decision: true, title: "OpenAI 兼容 · Chat Completions", search: "custom", googleSafety: false, customFeatures: true },
  openai_responses_compatible: { decision: true, title: "OpenAI 兼容 · Responses", search: "native", googleSafety: false, customFeatures: true },
  deepseek: { decision: false, title: "DeepSeek", search: "native", googleSafety: false, customFeatures: false },
  google: { decision: false, title: "Google AI Studio", search: "native", googleSafety: true, customFeatures: false },
  vertex: { decision: false, title: "Google Vertex AI", search: "native", googleSafety: true, customFeatures: false },
  vertex_express: { decision: false, title: "Google Vertex Express", search: "native", googleSafety: true, customFeatures: false },
  dashscope: { decision: true, title: "阿里云 DashScope", search: "native", googleSafety: false, customFeatures: false },
  lmstudio: { decision: true, title: "LM Studio", search: "none", googleSafety: false, customFeatures: true },
  anthropic: { decision: false, title: "Anthropic", search: "none", googleSafety: false, customFeatures: false }
} as const satisfies Record<LlmProviderType, { decision: boolean; title: string; search: "native" | "custom" | "none"; googleSafety: boolean; customFeatures: boolean }>;

/** 图像端点独立于聊天协议，能力由供应商类型明确声明。 */
export function supportsStandardImageGeneration(type: LlmProviderType): boolean {
  return type === "google" || type === "openai" || type === "openrouter" || type === "openai_compatible" || type === "openai_responses_compatible";
}

/** 仅这些协议已实现视频内容块；模型本身还必须明确声明 supportsVideoInput。 */
export function supportsNativeVideoInput(type: LlmProviderType): boolean {
  return ["google", "vertex", "vertex_express", "dashscope", "openrouter", "openai_compatible"].includes(type);
}

/** 供应商原生视频限制，和通用本地资源上限共同生效。 */
export function getNativeVideoInputLimits(type: LlmProviderType) {
  // DashScope Base64（编码后）必须小于 10 MB，视频时长至少 2 秒。
  return type === "dashscope"
    ? { minDurationMs: 2000, minFrames: 4, maxBytes: 7 * 1024 * 1024 }
    : { minDurationMs: 0, minFrames: 1, maxBytes: 20 * 1024 * 1024 };
}

export function supportsNativeDecision(type: unknown): boolean {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(llmProviderDefinitions, type) && llmProviderDefinitions[type as LlmProviderType].decision;
}

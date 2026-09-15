/** 供应商协议能力的单一目录；界面和运行时共用，不根据供应商别名猜测能力。 */
export const llmProviderTypes = ["openai", "openai_responses", "deepseek", "google", "vertex", "vertex_express", "dashscope", "lmstudio", "anthropic"] as const;
export type LlmProviderType = typeof llmProviderTypes[number];
export const llmProviderDefinitions = {
  openai: { title: "OpenAI 兼容 · Chat Completions", search: "custom", googleSafety: false, customFeatures: true },
  openai_responses: { title: "OpenAI 兼容 · Responses", search: "native", googleSafety: false, customFeatures: true },
  deepseek: { title: "DeepSeek", search: "native", googleSafety: false, customFeatures: false },
  google: { title: "Google AI Studio", search: "native", googleSafety: true, customFeatures: false },
  vertex: { title: "Google Vertex AI", search: "native", googleSafety: true, customFeatures: false },
  vertex_express: { title: "Google Vertex Express", search: "native", googleSafety: true, customFeatures: false },
  dashscope: { title: "阿里云 DashScope", search: "native", googleSafety: false, customFeatures: false },
  lmstudio: { title: "LM Studio", search: "none", googleSafety: false, customFeatures: true },
  anthropic: { title: "Anthropic", search: "none", googleSafety: false, customFeatures: false }
} as const satisfies Record<LlmProviderType, { title: string; search: "native" | "custom" | "none"; googleSafety: boolean; customFeatures: boolean }>;

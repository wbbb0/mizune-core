import type { GenerateContentConfig, ThinkingConfig, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { getGenerationSettings } from "../generationSettings.ts";
import { getProviderFeatureFromContext } from "../providerFeatures.ts";
import type { LlmProviderGenerateParams, LlmProviderRequestContext } from "../providerTypes.ts";
import { googlePlainText } from "./googleContent.ts";

const categories = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"] as const;
const extraKeys = new Set(["stopSequences", "seed", "frequencyPenalty", "responseLogprobs", "logprobs"]);

/** Protocol allowlist: advanced parameters cannot override transport or authority. */
export function buildAiStudioConfig(context: LlmProviderRequestContext, params: LlmProviderGenerateParams, signal: AbortSignal): GenerateContentConfig {
  const settings = getGenerationSettings(context);
  const defaults = settings?.defaults;
  const extra = defaults?.extra ?? {};
  for (const key of Object.keys(extra)) if (!extraKeys.has(key)) throw new Error(`AI Studio 不支持额外请求参数 ${key}；请使用对应的显式配置`);
  const system = params.messages.filter(message => message.role === "system").map(message => googlePlainText(message.content)).filter(Boolean).join("\n\n");
  const tools: NonNullable<GenerateContentConfig["tools"]> = [];
  if (params.tools?.length) tools.push({ functionDeclarations: params.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, parametersJsonSchema: tool.function.parameters })) });
  const search = getProviderFeatureFromContext(context, "search");
  if (search?.type === "builtin_tool") tools.push(search.tool);
  const thinking = settings && "googleThinking" in settings ? settings.googleThinking : undefined;
  const maxOutputTokens = params.maxOutputTokensOverride ?? defaults?.maxOutputTokens;
  let thinkingConfig: ThinkingConfig | undefined;
  if (settings?.capabilities.supportsThinking) {
    thinkingConfig = { includeThoughts: params.enableThinkingOverride ?? false };
    if (thinking?.mode === "budget") {
      const disabled = params.enableThinkingOverride === false && settings.capabilities.thinkingControllable === true;
      thinkingConfig.thinkingBudget = disabled ? 0 : thinking.budget;
      if (thinkingConfig.thinkingBudget === 0 && settings.capabilities.thinkingControllable !== true) throw new Error("此模型未声明可关闭思考");
    } else if (thinking?.mode === "level") {
      thinkingConfig.thinkingLevel = thinking.level as NonNullable<ThinkingConfig["thinkingLevel"]>;
    }
  } else if (thinking) throw new Error("模型未声明支持思考，不能设置 googleThinking");
  return {
    ...extra,
    ...(system ? { systemInstruction: system } : {}),
    ...(tools.length ? { tools } : {}),
    ...(params.tools?.length && search ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
    safetySettings: categories.map(category => ({ category: category as HarmCategory, threshold: (context.providerConfig.harmBlockThreshold ?? "BLOCK_NONE") as HarmBlockThreshold })),
    ...(defaults?.temperature !== undefined ? { temperature: defaults.temperature } : {}),
    ...(defaults?.top_p !== undefined ? { topP: defaults.top_p } : {}),
    ...(defaults?.top_k !== undefined ? { topK: defaults.top_k } : {}),
    ...(defaults?.presence_penalty !== undefined ? { presencePenalty: defaults.presence_penalty } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
    ...(params.responseFormat ? { responseMimeType: "application/json", ...(params.responseFormat.type === "json_schema" ? { responseJsonSchema: params.responseFormat.schema } : {}) } : {}),
    store: false,
    automaticContinuation: false,
    automaticFunctionCalling: { disable: true },
    abortSignal: signal
  };
}

import { OpenRouterProvider } from "./providers/openRouterProvider.ts";
import type { LlmProvider, LlmProviderRequestContext } from "./providerTypes.ts";
import { AnthropicProvider } from "./providers/anthropicProvider.ts";
import { DashScopeProvider } from "./providers/dashScopeProvider.ts";
import { DeepSeekProvider } from "./providers/deepSeekProvider.ts";
import { GoogleAiStudioProvider } from "./providers/googleAiStudioProvider.ts";
import { LmStudioProvider } from "./providers/lmStudioProvider.ts";
import { OpenAiCompatibleProvider } from "./providers/openAiCompatibleProvider.ts";
import { OpenAiResponsesCompatibleProvider } from "./providers/openAiResponsesProvider.ts";
import { OpenAiOfficialProvider } from "./providers/openAiOfficialProvider.ts";
import { VertexAiProvider } from "./providers/vertexAiProvider.ts";
import { VertexExpressProvider } from "./providers/vertexExpressProvider.ts";

const providers = new Map<string, LlmProvider>([
  ["openrouter", new OpenRouterProvider()],
  ["openai", new OpenAiOfficialProvider()],
  ["openai_compatible", new OpenAiCompatibleProvider()],
  ["openai_responses_compatible", new OpenAiResponsesCompatibleProvider()],
  ["deepseek", new DeepSeekProvider()],
  ["dashscope", new DashScopeProvider()],
  ["google", new GoogleAiStudioProvider()],
  ["vertex", new VertexAiProvider()],
  ["vertex_express", new VertexExpressProvider()],
  ["lmstudio", new LmStudioProvider()],
  ["anthropic", new AnthropicProvider()]
]);

export function hasLlmProvider(type: string): boolean {
  return providers.has(type);
}

export function getLlmProvider(context: LlmProviderRequestContext): LlmProvider {
  const provider = providers.get(context.providerConfig.type);
  if (!provider) {
    throw new Error(
      `Unsupported LLM provider type: ${context.providerConfig.type} (provider: ${context.providerName})`
    );
  }
  return provider;
}

export function resolveProviderBaseUrl(config: LlmProviderRequestContext["providerConfig"]): string | null {
  return providers.get(config.type)?.resolveBaseUrl(config) ?? null;
}

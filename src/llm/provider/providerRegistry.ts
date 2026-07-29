import type { LlmProvider, LlmProviderRequestContext } from "./providerTypes.ts";
import { AnthropicProvider } from "./providers/anthropicProvider.ts";
import { DashScopeProvider } from "./providers/dashScopeProvider.ts";
import { DeepSeekProvider } from "./providers/deepSeekProvider.ts";
import { GoogleAiStudioProvider } from "./providers/googleAiStudioProvider.ts";
import { LmStudioProvider } from "./providers/lmStudioProvider.ts";
import { OpenAiProvider } from "./providers/openaiProvider.ts";
import { OpenAiResponsesProvider } from "./providers/openAiResponsesProvider.ts";
import { VertexAiProvider } from "./providers/vertexAiProvider.ts";
import { VertexExpressProvider } from "./providers/vertexExpressProvider.ts";

const providers = new Map<string, LlmProvider>([
  ["openai", new OpenAiProvider()],
  ["openai_responses", new OpenAiResponsesProvider()],
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

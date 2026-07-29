import type { LlmProviderRequestContext } from "./providerTypes.ts";

type KnownModelApiParameter =
  | "temperature"
  | "top_p"
  | "top_k"
  | "min_p"
  | "presence_penalty"
  | "repetition_penalty";

const OPENAI_COMPAT_PARAMETER_KEYS: KnownModelApiParameter[] = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "repetition_penalty"
];

const GEMINI_PARAMETER_MAP: Partial<Record<KnownModelApiParameter, string>> = {
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  presence_penalty: "presencePenalty"
};

export function buildOpenAiCompatibleModelApiParameters(
  context: LlmProviderRequestContext
): Record<string, unknown> {
  return buildMappedParameters(context, Object.fromEntries(
    OPENAI_COMPAT_PARAMETER_KEYS.map((key) => [key, key])
  ));
}

export function buildOpenAiResponsesModelApiParameters(
  context: LlmProviderRequestContext
): Record<string, unknown> {
  return buildMappedParameters(context, {
    temperature: "temperature",
    top_p: "top_p"
  });
}

export function buildDashScopeModelApiParameters(
  context: LlmProviderRequestContext
): Record<string, unknown> {
  return buildMappedParameters(context, Object.fromEntries(
    OPENAI_COMPAT_PARAMETER_KEYS.map((key) => [key, key])
  ));
}

export function buildGeminiGenerationConfigParameters(
  context: LlmProviderRequestContext
): Record<string, unknown> {
  return buildMappedParameters(context, GEMINI_PARAMETER_MAP);
}

export function buildLmStudioNativeModelApiParameters(
  context: LlmProviderRequestContext
): Record<string, unknown> {
  return buildMappedParameters(context, {
    temperature: "temperature",
    top_p: "top_p",
    top_k: "top_k",
    min_p: "min_p",
    presence_penalty: "presence_penalty",
    repetition_penalty: "repeat_penalty"
  });
}

function buildMappedParameters(
  context: LlmProviderRequestContext,
  keyMap: Partial<Record<KnownModelApiParameter, string>>
): Record<string, unknown> {
  const source = context.modelProfile.apiParameters;
  if (!source) {
    return {};
  }

  const result: Record<string, unknown> = {
    ...objectRecord(source.extra)
  };

  for (const [sourceKey, targetKey] of Object.entries(keyMap) as Array<[KnownModelApiParameter, string]>) {
    const value = source[sourceKey];
    if (value !== undefined) {
      result[targetKey] = value;
    }
  }

  return result;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

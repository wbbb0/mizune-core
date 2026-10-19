/** Only documented structural fields are interpreted. Names are never capability heuristics. */
export type DiscoveredModel = { id: string; profile: Record<string, unknown>; source: string };
type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
const boolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
function defined(value: ObjectValue): ObjectValue { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)); }

export function parseDiscoveredModels(payload: unknown, source: string, kind: "generic" | "chat" | "embedding" | "image" | "google" | "lmstudio" | "anthropic"): DiscoveredModel[] {
  const root = object(payload);
  const rows = root.data ?? root.models;
  if (!Array.isArray(rows)) throw new Error("模型清单接口响应格式不正确：缺少模型数组");
  return rows.flatMap((raw) => {
    const item = object(raw);
    const id = kind === "google" ? (typeof item.name === "string" ? item.name.replace(/^models\//, "") : undefined) : item.id ?? item.key;
    if (typeof id !== "string" || !id.trim()) return [];
    const architecture = object(item.architecture);
    const input = strings(architecture.input_modalities);
    const output = strings(architecture.output_modalities);
    const methods = strings(item.supportedGenerationMethods);
    const parameters: string[] | undefined = Array.isArray(item.supported_parameters) ? item.supported_parameters : undefined;
    const displayName = item.display_name ?? item.displayName ?? (kind === "google" ? undefined : item.name);
    const profile: ObjectValue = defined({ displayName: typeof displayName === "string" && displayName.trim() ? displayName : undefined });
    const isEmbedding = kind === "embedding" || item.type === "embedding" || output?.includes("embeddings") || methods?.includes("embedContent");
    const isChat = (kind === "chat" || kind === "anthropic" || item.type === "llm" || output?.includes("text") || methods?.includes("generateContent"));
    if (isChat) {
      const caps = object(item.capabilities);
      const reasoning = object(item.reasoning);
      const limits = defined({
        contextTokens: positive(item.context_length ?? item.max_context_length),
        maxInputTokens: positive(item.max_input_tokens ?? item.inputTokenLimit),
        maxOutputTokens: positive(item.max_tokens ?? item.outputTokenLimit ?? item.top_provider?.max_completion_tokens)
      });
      // Loaded local context is a separate runtime limit, not the model's advertised maximum.
      const loaded = (Array.isArray(item.loaded_instances) ? item.loaded_instances : []).map((instance: ObjectValue) => positive(object(instance).config?.context_length)).filter(Boolean);
      if (loaded?.length === 1) limits.contextTokens = Math.min(limits.contextTokens ?? Infinity, loaded[0]!);
      profile.chat = {
        limits, capabilities: defined({
          supportsVision: typeof caps.vision === "boolean" ? caps.vision : boolean(caps.image_input?.supported) ?? (Array.isArray(input) ? input.includes("image") : undefined),
          supportsAudioInput: Array.isArray(input) ? input.includes("audio") : undefined,
          supportsTools: boolean(caps.trained_for_tool_use) ?? (parameters ? parameters.includes("tools") : undefined),
          supportsThinking: boolean(caps.thinking?.supported) ?? (typeof item.thinking === "boolean" ? item.thinking : parameters ? parameters.includes("reasoning") || parameters.includes("reasoning_effort") : undefined),
          thinkingControllable: boolean(caps.thinking?.types?.disabled?.supported) ?? (typeof reasoning.mandatory === "boolean" ? !reasoning.mandatory : strings(caps.reasoning?.allowed_options)?.includes("off")),
          supportsSearch: boolean(caps.server_tools?.web_search?.supported)
        })
      };
    }
    if (isEmbedding) profile.embedding = { limits: defined({ maxInputTokens: positive(item.inputTokenLimit ?? item.context_length ?? item.max_context_length) }) };
    // Image output via chat alone does not prove support for a dedicated Images API.
    if (kind === "image" || item.type === "image_generation") {
      const params = object(item.supported_parameters);
      const enums = (name: string) => params[name]?.type === "enum" && Array.isArray(params[name].values)
        ? params[name].values.filter((value: unknown) => typeof value === "string") : undefined;
      profile.image = {
        capabilities: defined({ referenceImages: Array.isArray(input) ? input.includes("image") : undefined, streaming: typeof item.supports_streaming === "boolean" ? item.supports_streaming : undefined }),
        constraints: defined({ sizes: enums("size"), aspectRatios: enums("aspect_ratio"), resolutions: enums("resolution"), qualities: enums("quality") })
      };
    }
    return [{ id: id.trim(), profile, source }];
  });
}

/** Fill only absent fields. Explicit false, zero, arrays and manual defaults remain untouched. */
export function fillMissingModelFields(existing: ObjectValue, discovered: ObjectValue): ObjectValue {
  const result = structuredClone(existing);
  for (const [key, value] of Object.entries(discovered)) {
    if (result[key] === undefined) result[key] = structuredClone(value);
    else if (value && result[key] && typeof value === "object" && typeof result[key] === "object" && !Array.isArray(value) && !Array.isArray(result[key])) {
      result[key] = fillMissingModelFields(result[key], value);
    }
  }
  return result;
}

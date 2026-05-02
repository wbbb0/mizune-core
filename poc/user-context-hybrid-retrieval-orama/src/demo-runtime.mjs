export const DEFAULT_CHAT_BASE_URL = "http://192.168.0.223:1234/v1";
export const DEFAULT_EMBEDDING_BASE_URL = "http://localhost:1234/v1";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-qwen3-embedding-0.6b";
export const DEFAULT_CHAT_MODEL = "custom/qwen3.6-27b-q5";

export function resolveDemoRuntime(args, scenario) {
  const apiKey = args.apiKey;
  const timeoutMs = 120_000;
  return {
    scenario,
    userId: args.userId || scenario.userId,
    queryText: args.query || scenario.query,
    chatModel: args.chatModel,
    embeddingModel: args.embeddingModel,
    chatConfig: {
      baseUrl: args.baseUrl,
      apiKey,
      timeoutMs,
    },
    embeddingConfig: {
      baseUrl: args.embeddingBaseUrl || process.env.POC_EMBEDDING_BASE_URL || DEFAULT_EMBEDDING_BASE_URL,
      apiKey,
      timeoutMs,
    },
  };
}

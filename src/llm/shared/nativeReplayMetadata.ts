import type { LlmMessage } from "#llm/llmClient.ts";
import { invalidateGoogleReplay } from "./googleReplay.ts";

/** 原生载荷绑定原始内容；请求视图改变内容后不能再用它覆盖投影结果。 */
export function invalidateNativeReplayMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const projected = invalidateGoogleReplay(metadata);
  if (!projected) return projected;
  const { openAiResponses: _responses, anthropicContentBlocks: _anthropic, ...rest } = projected;
  return rest;
}

export function hasNativeReplayPayload(metadata: Record<string, unknown> | undefined): boolean {
  return Boolean(metadata && (Array.isArray(metadata.googleParts)
    || Array.isArray(metadata.anthropicContentBlocks) || metadata.openAiResponses != null));
}

export function projectReplayMessageContent<T extends LlmMessage>(message: T, content: LlmMessage["content"]): T {
  if (JSON.stringify(content) === JSON.stringify(message.content)) return message;
  return { ...message, content, ...(message.providerMetadata
    ? { providerMetadata: invalidateNativeReplayMetadata(message.providerMetadata) }
    : {}) };
}

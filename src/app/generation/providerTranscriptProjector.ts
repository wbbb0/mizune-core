import type { LlmMessage } from "#llm/llmClient.ts";
import type { AppConfig } from "#config/config.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { InternalAssistantToolCallItem, InternalToolResultItem } from "#conversation/session/sessionTypes.ts";
import { projectTranscriptMessageItemToHistoryMessage } from "#conversation/session/historyContext.ts";
import { isTranscriptLlmVisible, isTranscriptRuntimeIncluded } from "#conversation/session/sessionTranscript.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";

const RECENT_RAW_TOOL_RESULT_COUNT = 5;

export interface ProviderTranscriptProjection {
  replayMessages: LlmMessage[];
  lateSystemMessages: string[];
  replayCoversVisibleHistory: boolean;
}

export interface ProviderTranscriptProjector {
  providerName: string;
  project(input: {
    transcript: InternalTranscriptItem[];
    preserveThinking?: boolean;
    requireThoughtSignatures?: boolean;
  }): ProviderTranscriptProjection;
}

function summarizeTranscriptItem(item: InternalTranscriptItem): string | null {
  if (item.kind === "assistant_tool_call") {
    const names = item.toolCalls.map((toolCall) => toolCall.function.name).join(", ");
    return `- 调用工具：${names || "<none>"}`;
  }
  if (item.kind === "tool_result") {
    return summarizeToolResultItem(item);
  }
  return null;
}

function summarizeToolResultItem(item: InternalToolResultItem): string {
  const resource = item.observation?.resource
    ? ` resource=${item.observation.resource.kind}:${item.observation.resource.id}`
    : "";
  if (item.observation?.summary) {
    return `- ${item.toolName}${resource}: ${item.observation.summary}`;
  }
  const normalized = rawToolResultContent(item).replace(/\s+/g, " ").trim();
  return `- ${item.toolName}${resource}: ${normalized.length <= 180 ? normalized : `${normalized.slice(0, 180)}...`}`;
}

function buildToolSummarySystemMessage(providerName: string, lines: string[]): string | null {
  return lines.length > 0
    ? `最近工具结果摘要（provider=${providerName}；跨轮仅提供摘要，不要对用户直说）：\n${lines.join("\n")}`
    : null;
}

function createSummaryOnlyProjector(providerName: string): ProviderTranscriptProjector {
  return {
    providerName,
    project(input) {
      const lines = input.transcript
        .filter(isTranscriptRuntimeIncluded)
        .slice(-12)
        .map(summarizeTranscriptItem)
        .filter((line): line is string => Boolean(line));
      return {
        replayMessages: [],
        replayCoversVisibleHistory: false,
        lateSystemMessages: [buildToolSummarySystemMessage(providerName, lines)].filter((item): item is string => Boolean(item))
      };
    }
  };
}

function createOpenAiStyleProjector(
  providerName: string,
  options: {
    preserveVisibleReasoning?: boolean;
  } = {}
): ProviderTranscriptProjector {
  return {
    providerName,
    project(input) {
      const replayMessages: LlmMessage[] = [];
      const lateSystemMessages: string[] = [];
      const degradedLines: string[] = [];
      const runtimeTranscript = input.transcript.filter(isTranscriptRuntimeIncluded);
      const toolResultReplayContent = buildToolResultReplayContentMap(input.transcript);
      let replayCoversVisibleHistory = false;

      for (let index = 0; index < runtimeTranscript.length; index += 1) {
        const item = runtimeTranscript[index];
        if (!item) {
          continue;
        }
        if (
          input.preserveThinking
          && (
            item.kind === "user_message"
            || item.kind === "user_media_message"
            || item.kind === "assistant_message"
            || item.kind === "session_mode_switch"
            || item.kind === "profile_phase_transition"
          )
          && isTranscriptLlmVisible(item)
        ) {
          const historyMessage = projectTranscriptMessageItemToHistoryMessage(item);
          replayMessages.push({
            role: historyMessage.role,
            content: historyMessage.content,
            ...(options.preserveVisibleReasoning !== false && item.kind === "assistant_message" && item.reasoningContent
              ? { reasoning_content: item.reasoningContent }
              : {})
          });
          replayCoversVisibleHistory = true;
          continue;
        }
        if (item.kind === "assistant_tool_call") {
          const expectedToolCallIds = new Set(item.toolCalls.map((toolCall) => toolCall.id));
          const followingToolResults: InternalToolResultItem[] = [];
          let nextIndex = index + 1;
          while (nextIndex < runtimeTranscript.length) {
            const nextItem = runtimeTranscript[nextIndex];
            if (!nextItem || isOpenAiStyleToolReplayBoundary(nextItem)) {
              break;
            }
            if (nextItem.kind === "tool_result") {
              followingToolResults.push(nextItem);
            }
            nextIndex += 1;
          }
          const resultToolCallIds = new Set(followingToolResults.map((result) => result.toolCallId));
          const duplicateToolCallIds = findDuplicateToolResultIds(followingToolResults);
          const unknownToolCallIds = [...resultToolCallIds].filter((toolCallId) => !expectedToolCallIds.has(toolCallId));
          const missingToolCallIds = [...expectedToolCallIds].filter((toolCallId) => !resultToolCallIds.has(toolCallId));
          if (
            expectedToolCallIds.size === 0
            || missingToolCallIds.length > 0
            || unknownToolCallIds.length > 0
            || duplicateToolCallIds.length > 0
          ) {
            const names = item.toolCalls.map((toolCall) => toolCall.function.name).join(", ") || "<none>";
            degradedLines.push(`- 工具调用历史不完整，已从 provider replay 省略：${names}`);
            index = nextIndex - 1;
            continue;
          }

          replayMessages.push({
            role: "assistant",
            content: item.content,
            tool_calls: item.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
              },
              ...(toolCall.providerMetadata ? { providerMetadata: toolCall.providerMetadata as any } : {})
            })),
            ...(item.reasoningContent ? { reasoning_content: item.reasoningContent } : {}),
            ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {})
          });
          for (const toolResult of followingToolResults) {
            if (!expectedToolCallIds.has(toolResult.toolCallId)) {
              degradedLines.push(`- 孤立工具结果已从 provider replay 省略：${toolResult.toolName}`);
              continue;
            }
            replayMessages.push({
              role: "tool",
              tool_call_id: toolResult.toolCallId,
              content: toolResultReplayContent.get(toolResult.toolCallId) ?? rawToolResultContent(toolResult)
            });
          }
          index = nextIndex - 1;
          continue;
        }
        if (item.kind === "tool_result") {
          degradedLines.push(`- 孤立工具结果已从 provider replay 省略：${item.toolName}`);
          continue;
        }
        if (item.kind === "system_marker") {
          degradedLines.push(`- marker ${item.markerType}: ${item.content}`);
        }
      }

      if (degradedLines.length > 0) {
        lateSystemMessages.push(`最近内部元数据摘要（provider=${providerName}）：\n${degradedLines.join("\n")}`);
      }
      return { replayMessages, lateSystemMessages, replayCoversVisibleHistory };
    }
  };
}

function isOpenAiStyleToolReplayBoundary(item: InternalTranscriptItem): boolean {
  return (
    item.kind === "user_message"
    || item.kind === "user_media_message"
    || item.kind === "assistant_message"
    || item.kind === "assistant_tool_call"
    || item.kind === "session_mode_switch"
    || item.kind === "profile_phase_transition"
  );
}

function findDuplicateToolResultIds(items: InternalToolResultItem[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.toolCallId)) {
      duplicates.add(item.toolCallId);
      continue;
    }
    seen.add(item.toolCallId);
  }
  return [...duplicates];
}

function buildToolResultReplayContentMap(transcript: InternalTranscriptItem[]): Map<string, string> {
  const includedToolResults = transcript
    .filter(isTranscriptRuntimeIncluded)
    .filter((item): item is InternalToolResultItem => item.kind === "tool_result");
  const replayContent = new Map<string, string>();

  includedToolResults.forEach((item, index) => {
    if (shouldReplayRawToolResult(item, index, includedToolResults.length)) {
      replayContent.set(item.toolCallId, rawToolResultContent(item));
      return;
    }
    replayContent.set(item.toolCallId, compactToolResultForReplay(item));
  });

  return replayContent;
}

function shouldReplayRawToolResult(item: InternalToolResultItem, index: number, totalCount: number): boolean {
  if (item.observation?.replaySafe === false) {
    return false;
  }
  const preserveCount = item.observation?.preserveRecentRawCount ?? RECENT_RAW_TOOL_RESULT_COUNT;
  return index >= Math.max(0, totalCount - preserveCount) || item.observation?.pinned === true;
}

function compactToolResultForReplay(item: InternalToolResultItem): string {
  if (item.observation?.replaySafe === false) {
    if (typeof item.observation.replayContent === "string" && item.observation.replayContent.length > 0) {
      return item.observation.replayContent;
    }
    return JSON.stringify({
      ok: true,
      compacted: true,
      tool: item.toolName,
      summary: item.observation.summary || "该工具结果已标记为不可安全 replay，历史上下文仅保留摘要占位。"
    });
  }
  if (item.observation?.retention === "full") {
    return rawToolResultContent(item);
  }
  if (typeof item.observation?.replayContent === "string" && item.observation.replayContent.length > 0) {
    return item.observation.replayContent;
  }
  const normalized = item.content.replace(/\s+/g, " ").trim();
  return JSON.stringify({
    ok: true,
    compacted: true,
    tool: item.toolName,
    summary: normalized.length <= 300 ? normalized : `${normalized.slice(0, 300)}...`
  });
}

function rawToolResultContent(item: InternalToolResultItem): string {
  return item.canonicalContent ?? item.content;
}

function canReplayGoogleToolCallItem(item: InternalAssistantToolCallItem, requireThoughtSignatures: boolean): boolean {
  if (!requireThoughtSignatures) {
    return item.toolCalls.length > 0;
  }

  const rawParts = Array.isArray(item.providerMetadata?.googleParts)
    ? item.providerMetadata.googleParts as unknown[]
    : null;
  if (rawParts && rawParts.length > 0) {
    return rawParts.every((part) => {
      if (!part || typeof part !== "object" || !("functionCall" in part)) {
        return true;
      }
      const googlePart = part as { thoughtSignature?: unknown };
      return typeof googlePart.thoughtSignature === "string" && googlePart.thoughtSignature.length > 0;
    });
  }
  return item.toolCalls.every((toolCall) => {
    const google = toolCall.providerMetadata?.google as { thoughtSignature?: string } | undefined;
    return typeof google?.thoughtSignature === "string" && google.thoughtSignature.length > 0;
  });
}

function createGoogleProjector(providerName: string): ProviderTranscriptProjector {
  return {
    providerName,
    project(input) {
      const replayMessages: LlmMessage[] = [];
      const replayableToolCallIds = new Set<string>();
      const activeReplayableToolCallIds = new Set<string>();
      const skippedToolCallIds = new Set<string>();
      const skippedLines: string[] = [];
      const toolResultReplayContent = buildToolResultReplayContentMap(input.transcript);
      let replayCoversVisibleHistory = false;
      let lastReplayRole: LlmMessage["role"] | null = null;
      const requireThoughtSignatures = input.requireThoughtSignatures ?? true;

      const clearActiveReplayableToolCalls = (): void => {
        activeReplayableToolCallIds.clear();
      };

      for (const item of input.transcript) {
        if (!isTranscriptRuntimeIncluded(item)) {
          continue;
        }
        if ((item.kind === "user_message" || item.kind === "user_media_message" || item.kind === "assistant_message") && isTranscriptLlmVisible(item)) {
          clearActiveReplayableToolCalls();
          const historyMessage = projectTranscriptMessageItemToHistoryMessage(item);
          replayMessages.push({
            role: historyMessage.role,
            content: historyMessage.content
          });
          replayCoversVisibleHistory = true;
          lastReplayRole = historyMessage.role;
          continue;
        }

        if (item.kind === "assistant_tool_call") {
          clearActiveReplayableToolCalls();
          if (
            canReplayGoogleToolCallItem(item, requireThoughtSignatures)
            && (lastReplayRole === "user" || lastReplayRole === "tool")
          ) {
            for (const toolCall of item.toolCalls) {
              replayableToolCallIds.add(toolCall.id);
              activeReplayableToolCallIds.add(toolCall.id);
            }
            replayMessages.push({
              role: "assistant",
              content: item.content,
              tool_calls: item.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments
                },
                ...(toolCall.providerMetadata ? { providerMetadata: toolCall.providerMetadata as any } : {})
              })),
              ...(item.reasoningContent ? { reasoning_content: item.reasoningContent } : {}),
              ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {})
            });
            lastReplayRole = "assistant";
          } else {
            skippedLines.push(summarizeTranscriptItem(item)!);
            for (const toolCall of item.toolCalls) {
              skippedToolCallIds.add(toolCall.id);
            }
          }
          continue;
        }

        if (item.kind === "tool_result") {
          if (
            replayableToolCallIds.has(item.toolCallId)
            && activeReplayableToolCallIds.has(item.toolCallId)
            && (lastReplayRole === "assistant" || lastReplayRole === "tool")
          ) {
            replayMessages.push({
              role: "tool",
              tool_call_id: item.toolCallId,
              content: toolResultReplayContent.get(item.toolCallId) ?? rawToolResultContent(item)
            });
            lastReplayRole = "tool";
          } else if (skippedToolCallIds.has(item.toolCallId)) {
            skippedLines.push(summarizeToolResultItem(item));
          }
          continue;
        }
      }

      return {
        replayMessages,
        lateSystemMessages: [buildToolSummarySystemMessage(providerName, skippedLines)].filter((item): item is string => Boolean(item)),
        replayCoversVisibleHistory
      };
    }
  };
}

const projectors = new Map<string, ProviderTranscriptProjector>([
  ["openai", createOpenAiStyleProjector("openai")],
  ["dashscope", createOpenAiStyleProjector("dashscope")],
  ["deepseek", createOpenAiStyleProjector("deepseek")],
  ["lmstudio", createOpenAiStyleProjector("lmstudio")],
  ["anthropic", createOpenAiStyleProjector("anthropic", { preserveVisibleReasoning: false })],
  ["google", createGoogleProjector("google")],
  ["vertex", createGoogleProjector("vertex")],
  ["vertex_express", createGoogleProjector("vertex_express")]
]);

export function getProviderTranscriptProjector(providerName: string | null | undefined): ProviderTranscriptProjector {
  return getProviderTranscriptProjectorForRequest(providerName);
}

export function resolveProviderTranscriptProjectorName(config: AppConfig, modelRef: string | string[]): string {
  const modelProfile = getPrimaryModelProfile(config, modelRef);
  if (!modelProfile) {
    return "unknown";
  }
  return config.llm.providers[modelProfile.provider]?.type ?? modelProfile.provider;
}

export function getProviderTranscriptProjectorForRequest(
  providerName: string | null | undefined,
  options: {
    summaryOnly?: boolean;
  } = {}
): ProviderTranscriptProjector {
  if (options.summaryOnly === true) {
    return createSummaryOnlyProjector(providerName ?? "unknown");
  }
  return projectors.get(providerName ?? "") ?? createSummaryOnlyProjector(providerName ?? "unknown");
}

import type { LlmMessage } from "#llm/llmClient.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { InternalAssistantToolCallItem } from "#conversation/session/sessionTypes.ts";
import { projectTranscriptMessageItemToHistoryMessage } from "#conversation/session/historyContext.ts";
import { isTranscriptRuntimeIncluded } from "#conversation/session/sessionTranscript.ts";

export interface ProviderTranscriptProjection {
  replayMessages: LlmMessage[];
  lateSystemMessages: string[];
  replayCoversVisibleHistory: boolean;
}

export interface ProviderTranscriptProjector {
  providerName: string;
  project(input: {
    transcript: InternalTranscriptItem[];
  }): ProviderTranscriptProjection;
}

function summarizeTranscriptItem(item: InternalTranscriptItem): string | null {
  if (item.kind === "assistant_tool_call") {
    const names = item.toolCalls.map((toolCall) => toolCall.function.name).join(", ");
    return `- assistant tool_calls: ${names || "<none>"}`;
  }
  if (item.kind === "tool_result") {
    const normalized = item.content.replace(/\s+/g, " ").trim();
    return `- tool ${item.toolName}: ${normalized.length <= 180 ? normalized : `${normalized.slice(0, 180)}...`}`;
  }
  return null;
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
        lateSystemMessages: lines.length > 0
          ? [`最近内部工具转录摘要（provider=${providerName}；跨轮仅提供摘要，不要对用户直说）：\n${lines.join("\n")}`]
          : []
      };
    }
  };
}

function createOpenAiStyleProjector(providerName: string): ProviderTranscriptProjector {
  return {
    providerName,
    project(input) {
      const replayMessages: LlmMessage[] = [];
      const lateSystemMessages: string[] = [];
      const degradedLines: string[] = [];

      for (const item of input.transcript) {
        if (!isTranscriptRuntimeIncluded(item)) {
          continue;
        }
        if (item.kind === "assistant_tool_call") {
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
          continue;
        }
        if (item.kind === "tool_result") {
          replayMessages.push({
            role: "tool",
            tool_call_id: item.toolCallId,
            content: item.content
          });
          continue;
        }
        if (item.kind === "system_marker") {
          degradedLines.push(`- marker ${item.markerType}: ${item.content}`);
        }
      }

      if (degradedLines.length > 0) {
        lateSystemMessages.push(`最近内部元数据摘要（provider=${providerName}）：\n${degradedLines.join("\n")}`);
      }
      return { replayMessages, lateSystemMessages, replayCoversVisibleHistory: false };
    }
  };
}

function canReplayGoogleToolCallItem(item: InternalAssistantToolCallItem): boolean {
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
      let replayCoversVisibleHistory = false;
      let lastReplayRole: LlmMessage["role"] | null = null;

      const clearActiveReplayableToolCalls = (): void => {
        activeReplayableToolCallIds.clear();
      };

      for (const item of input.transcript) {
        if (!isTranscriptRuntimeIncluded(item)) {
          continue;
        }
        if (item.kind === "user_message" || item.kind === "assistant_message") {
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
            canReplayGoogleToolCallItem(item)
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
          }
          // NOTE: 无法 replay 的工具调用（缺失 thoughtSignature）在此静默省略。
          // 如果模型在跨轮场景中频繁丢失工具调用上下文，可在 assistant visible response 的
          // prompt 中要求模型显式复述重要工具结果，使其通过 visible history 保留关键信息。
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
              content: item.content
            });
            lastReplayRole = "tool";
          }
          continue;
        }
      }

      return {
        replayMessages,
        lateSystemMessages: [],
        replayCoversVisibleHistory
      };
    }
  };
}

const projectors = new Map<string, ProviderTranscriptProjector>([
  ["openai", createOpenAiStyleProjector("openai")],
  ["dashscope", createOpenAiStyleProjector("dashscope")],
  ["google", createGoogleProjector("google")],
  ["vertex", createGoogleProjector("vertex")],
  ["vertex_express", createGoogleProjector("vertex_express")]
]);

export function getProviderTranscriptProjector(providerName: string | null | undefined): ProviderTranscriptProjector {
  return projectors.get(providerName ?? "") ?? createSummaryOnlyProjector(providerName ?? "unknown");
}

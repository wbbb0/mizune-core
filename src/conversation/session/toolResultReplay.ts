import { estimateTokens, type TokenEstimationWeights } from "./tokenEstimator.ts";
import type { InternalTranscriptItem, InternalToolResultItem } from "./sessionTypes.ts";
import { isTranscriptRuntimeIncluded } from "./transcriptVisibility.ts";

const RECENT_RAW_TOOL_RESULT_COUNT = 5;

export function shouldUseToolResultReplayContent(input: {
  rawContent: string;
  replayContent: string;
  replaySafe: boolean | undefined;
  tokenEstimationWeights?: TokenEstimationWeights | undefined;
}): boolean {
  if (input.replaySafe === false) {
    return true;
  }
  return estimateTokens(input.replayContent, input.tokenEstimationWeights)
    < estimateTokens(input.rawContent, input.tokenEstimationWeights);
}

export function buildToolResultReplayContentMap(
  transcript: InternalTranscriptItem[],
  tokenEstimationWeights?: TokenEstimationWeights,
  projectedContent?: ReadonlyMap<InternalTranscriptItem, string>
): Map<InternalToolResultItem, string> {
  const includedToolResults = transcript
    .filter(isTranscriptRuntimeIncluded)
    .filter((item): item is InternalToolResultItem => item.kind === "tool_result");
  const replayContent = new Map<InternalToolResultItem, string>();

  includedToolResults.forEach((item, index) => {
    const projected = projectedContent?.get(item);
    if (projected != null) {
      replayContent.set(item, projected);
      return;
    }
    if (shouldReplayRawToolResult(item, index, includedToolResults.length)) {
      replayContent.set(item, rawToolResultContent(item));
      return;
    }
    replayContent.set(item, compactToolResultForReplay(item, tokenEstimationWeights));
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

function compactToolResultForReplay(
  item: InternalToolResultItem,
  tokenEstimationWeights?: TokenEstimationWeights
): string {
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
    const rawContent = rawToolResultContent(item);
    return shouldUseToolResultReplayContent({
      rawContent,
      replayContent: item.observation.replayContent,
      replaySafe: item.observation.replaySafe,
      ...(tokenEstimationWeights ? { tokenEstimationWeights } : {})
    })
      ? item.observation.replayContent
      : rawContent;
  }
  const normalized = item.content.replace(/\s+/g, " ").trim();
  return JSON.stringify({
    ok: true,
    compacted: true,
    tool: item.toolName,
    summary: normalized.length <= 300 ? normalized : `${normalized.slice(0, 300)}...`
  });
}

export function rawToolResultContent(item: InternalToolResultItem): string {
  return item.canonicalContent ?? item.content;
}

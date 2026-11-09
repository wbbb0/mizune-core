import { buildToolResultReplayContentMap } from "./toolResultReplay.ts";
import type { AppConfig } from "#config/config.ts";
import { getRoutingPresetHistoryWindow } from "#llm/shared/modelRouting.ts";
import { parseProtocolLine } from "#utils/structuredEnvelope.ts";
import { hasNativeReplayPayload } from "#llm/shared/nativeReplayMetadata.ts";
import { formatStructuredMediaReference, projectTranscriptMessageItemToHistoryMessage } from "./historyContext.ts";
import { isTranscriptHistoryMessage, isTranscriptLlmVisible, isTranscriptRuntimeIncluded, type HistoryTranscriptItem } from "./transcriptVisibility.ts";
import type { InternalTranscriptItem, SessionHistoryMessage } from "./sessionTypes.ts";

/** 只选择本次请求视图；不修改持久化历史、runtimeExcluded 或原生签名块。 */
export interface RequestContextSelection {
  transcript: InternalTranscriptItem[];
  historyItems: HistoryTranscriptItem[];
  history: SessionHistoryMessage[];
  contentByItem: ReadonlyMap<InternalTranscriptItem, string>;
  invalidatedNativeItems: ReadonlySet<InternalTranscriptItem>;
}

export function selectRequestContext(transcript: InternalTranscriptItem[], config: AppConfig): RequestContextSelection {
  const runtime = transcript.filter(isTranscriptRuntimeIncluded);
  const window = getRoutingPresetHistoryWindow(config);
  const visible = runtime.filter(isTranscriptLlmVisible).filter(isTranscriptHistoryMessage);
  const count = Math.max(0, window.maxRecentMessages);
  const historyItems = count > 0 ? visible.slice(-count) : [];
  // 从首个选中可见项向后取结构，窗口之前的工具交换不会被独立重新引入。
  const first = historyItems[0];
  const structuralStarts = runtime.flatMap((item, index) => item.kind === "assistant_tool_call" ? [index] : []);
  const start = first ? runtime.indexOf(first) : (count > 0 ? structuralStarts.at(-count) ?? runtime.length : runtime.length);
  const selected = runtime.slice(start);
  const historySet = new Set<InternalTranscriptItem>(historyItems);
  const selectedSet = new Set(selected);
  const invalidatedNativeItems = new Set<InternalTranscriptItem>();
  for (const item of selected) {
    if (item.kind !== "assistant_message" || !item.groupId || !hasNativeReplayPayload(item.providerMetadata)) continue;
    if (runtime.some(source => source.kind === "assistant_message" && source.groupId === item.groupId && !selectedSet.has(source))) {
      invalidatedNativeItems.add(item);
    }
  }
  const contentByItem = new Map<InternalTranscriptItem, string>();
  const toolContent = buildToolResultReplayContentMap(selected, config.conversation.historyCompression.tokenEstimation);
  for (const item of selected) {
    if (isTranscriptHistoryMessage(item)) {
      if (historySet.has(item)) contentByItem.set(item, projectTranscriptMessageItemToHistoryMessage(item).content);
    } else if (item.kind === "tool_result") {
      contentByItem.set(item, toolContent.get(item)!);
    } else if (item.kind === "assistant_tool_call" || item.kind === "system_marker") {
      contentByItem.set(item, item.content);
    }
  }
  let remaining = Math.max(0, window.maxImageReferences);
  for (const item of [...selected].reverse()) {
    const content = contentByItem.get(item);
    if (content == null) continue;
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    let changed = false;
    for (let index = lines.length - 1; index >= 0; index--) {
      const tag = parseProtocolLine(lines[index]!);
      if (!tag || (tag.tag !== "ref" && tag.tag !== "pending_media") || (tag.attrs.kind !== "image" && tag.attrs.kind !== "emoji")) continue;
      if (tag.attrs.image_id === "omitted") continue;
      if (remaining > 0) remaining--;
      else {
        lines[index] = formatStructuredMediaReference(tag.attrs.kind, "omitted");
        changed = true;
      }
    }
    if (changed) contentByItem.set(item, lines.join("\n"));
  }
  return {
    transcript: selected,
    historyItems,
    history: historyItems.map(item => ({ ...projectTranscriptMessageItemToHistoryMessage(item), content: contentByItem.get(item)! })),
    contentByItem,
    invalidatedNativeItems
  };
}

/** 安全投影保持历史项身份和顺序；native replay 与普通历史共享同一份投影。 */
export function withProjectedRequestHistory(selection: RequestContextSelection, history: readonly { content: string }[]): RequestContextSelection {
  if (history.length !== selection.historyItems.length) throw new Error("请求历史投影改变了消息数量");
  const contentByItem = new Map(selection.contentByItem);
  selection.historyItems.forEach((item, index) => contentByItem.set(item, history[index]!.content));
  return { ...selection, contentByItem, history: selection.history.map((item, index) => ({ ...item, content: history[index]!.content })) };
}

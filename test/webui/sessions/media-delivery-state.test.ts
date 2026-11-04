import test from "node:test";
import assert from "node:assert/strict";
import { describeMediaDelivery } from "../../../webui/src/components/sessions/mediaDeliveryState.ts";
import { buildChatTimelineItems } from "../../../webui/src/components/sessions/chatTimeline.ts";
import type { TranscriptItem } from "../../../webui/src/api/types.ts";

type Media = Extract<TranscriptItem, { kind: "outbound_media_message" }>;
function media(patch: Partial<Media> = {}): Media {
  return {
    id: "delivery-1", groupId: "response-1", runtimeExcluded: false, kind: "outbound_media_message", role: "assistant", llmVisible: false,
    deliveryStatus: "accepted", deliveryUpdatedAtMs: 1000,
    delivery: "qq_official", mediaKind: "image", fileId: "asset-1", fileRef: "asset.png", sourceName: "test.png",
    chatFilePath: null, sourcePath: null, messageId: null, toolName: "asset_send_to_chat", timestampMs: 1000,
    ...patch
  };
}
function timeline(item: Media) {
  return buildChatTimelineItems([{ id: item.id, eventId: item.id, index: 0, item }]);
}

test("media status distinguishes queued, submitting and platform acceptance without claiming client receipt", () => {
  const states = [
    ["queued", "等待发送"], ["sending", "发送中"], ["accepted", "平台已接受"],
    ["failed", "发送失败"], ["cancelled", "已取消"], ["unknown", "结果未知"]
  ] as const;
  for (const [deliveryStatus, label] of states) {
    const item = media({ deliveryStatus });
    const state = describeMediaDelivery(item);
    assert.equal(state.label, label);
    const cards = timeline(item);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.deliveryState?.label, label);
    assert.equal(cards[0]?.itemId, "delivery-1");
  }
  assert.match(describeMediaDelivery(media({ deliveryStatus: "accepted" })).detail, /客户端是否显示尚未确认/);
  assert.equal(describeMediaDelivery(media({ delivery: "web", deliveryStatus: "accepted" })).label, "已记录");
});

test("SSE media status patches retain a single logical card and source preview", () => {
  const item = media({ deliveryStatus: "queued", deliveryUpdatedAtMs: 1000 });
  const before = timeline(item)[0]!;
  // Session store merges transcript_item_patched into the same item by stable ID.
  const patched = { ...item, deliveryStatus: "unknown" as const, deliveryUpdatedAtMs: 2000,
    deliveryError: { stage: "message" as const, code: "transport", message: "请求结果未知" } };
  const after = timeline(patched)[0]!;
  assert.equal(before.id, after.id);
  assert.equal(before.itemId, after.itemId);
  assert.equal(after.deliveryState?.label, "结果未知");
  assert.equal(after.kind, "image");
  if (after.kind === "image") assert.equal(after.imageUrl, "/api/chat-files/asset-1/content");
});

test("failed media remains visible without an available preview, and audio and files carry status", () => {
  const failed = timeline(media({ fileId: null, fileRef: null, deliveryStatus: "failed",
    deliveryError: { stage: "upload", code: "850019", message: "平台拒绝了媒体格式" } }));
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.kind, "text");
  assert.equal(failed[0]?.deliveryState?.detail, "平台拒绝了媒体格式");
  for (const mediaKind of ["file", "audio"] as const) {
    const cards = timeline(media({ mediaKind, deliveryStatus: "sending" }));
    assert.equal(cards[0]?.kind, "content_parts");
    assert.equal(cards[0]?.deliveryState?.label, "发送中");
  }
});

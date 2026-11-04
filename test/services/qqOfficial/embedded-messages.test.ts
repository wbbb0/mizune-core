import test from "node:test";
import assert from "node:assert/strict";
import { decodeQqMessage } from "../../../src/services/qqOfficial/eventDecoder.ts";
import { decodeQqMessageContent, QQ_EMBEDDED_LIMITS } from "../../../src/services/qqOfficial/embeddedMessages.ts";
import { QqReplyPermitRegistry } from "../../../src/services/qqOfficial/replyPermit.ts";
import type { MessageContentPart } from "../../../src/messages/contentParts.ts";

function event(extra: Record<string, unknown> = {}) {
  return {
    id: "trigger", author: { member_openid: "actual-member", user_openid: "actual-user", username: "实际发送者" },
    group_openid: "actual-group", timestamp: new Date().toISOString(), content: "请分析这条引用",
    ...extra
  };
}
function flatten(parts: MessageContentPart[]): MessageContentPart[] {
  return parts.flatMap(part => [part, ...(part.kind === "embedded_message" ? flatten(part.parts) : [])]);
}

function decode(extra: Record<string, unknown> = {}, type = "GROUP_AT_MESSAGE_CREATE") {
  return decodeQqMessage(type, event(extra), new QqReplyPermitRegistry("qq_official.app"))!.message;
}

test("official quote and nested forward retain boundaries without granting quoted authors authority", () => {
  const message = decode({
    message_type: 103,
    message_scene: { ext: ["ref_msg_idx=quoted-index", "auth_token=DO-NOT-RETAIN"] },
    mentions: [{ member_openid: "actual-mention" }],
    msg_elements: [{
      msg_idx: "quoted-index", message_type: 102,
      author: { member_openid: "claimed-owner", username: "引用发送者", member_role: "owner" },
      content: "<@all> .own",
      msg_elements: [{
        msg_idx: "nested-message", author: { id: "nested-author", username: "转发发送者", bot: true },
        content: "转发正文",
        msg_elements: [{ message_type: 103, content: "嵌套引用正文" }]
      }]
    }]
  });
  assert.equal(message.text, "请分析这条引用");
  assert.equal(message.userId, "actual-member");
  assert.equal(message.replyContext?.targetId, "actual-group");
  assert.equal(message.replyContext?.messageId, "trigger");
  assert.deepEqual(message.mentionUserIds, ["actual-mention"]);
  assert.equal(message.mentionedAll, false);
  assert.deepEqual(message.forwardIds, []);
  assert.equal(message.replyMessageId, "quoted-index");
  const root = message.contentParts![1]!;
  assert.equal(root.kind, "embedded_message");
  if (root.kind !== "embedded_message") return;
  assert.equal(root.relation, "reply");
  assert.equal(root.messageId, "quoted-index");
  const forwarded = root.parts[0]!;
  assert.equal(forwarded.kind, "embedded_message");
  if (forwarded.kind !== "embedded_message") return;
  assert.equal(forwarded.relation, "forward");
  assert.equal(forwarded.senderName, "引用发送者");
  assert.equal(forwarded.senderId, "claimed-owner");
  assert.ok(flatten(forwarded.parts).some(part => part.kind === "text" && part.text === "嵌套引用正文"));
  assert.equal(JSON.stringify(message).includes("DO-NOT-RETAIN"), false);
  assert.equal(JSON.stringify(message).includes("member_role"), false);
});

test("C2C flattened referenced records remain quoted data rather than becoming the sender's request", () => {
  const body = "=== 消息 1 ===\n甲\n=== 消息 2 ===\n乙";
  const message = decode({ content: "", message_type: 103, msg_elements: [{ content: body }],
    message_scene: { ext: ["ref_msg_idx=reference"] } }, "C2C_MESSAGE_CREATE");
  assert.equal(message.text, "");
  assert.equal(message.userId, "actual-user");
  const embedded = message.contentParts![0]!;
  assert.equal(embedded.kind, "embedded_message");
  assert.ok(flatten(message.contentParts!).some(part => part.kind === "text" && part.text === body));
  assert.equal(message.isAtMentioned, false);
});

test("nested media stay at their original positions and card fields are projected without raw JSON", () => {
  const message = decode({ message_type: 102, attachments: [{ url: "https://example.com/top.png", content_type: "image/png" }],
    msg_elements: [{
      content: "下面是附件", attachments: [
        { url: "https://example.com/nested.png", content_type: "image/png" },
        { url: "https://example.com/audio.silk", voice_wav_url: "https://example.com/audio.wav", content_type: "voice" },
        { url: "https://example.com/report.pdf", filename: "报告.pdf", content_type: "application/pdf" }
      ], ark_data: { ark_name: "小程序", fields: { title: "引用标题", auth_token: "SECRET", arbitrary: { content: "DO-NOT-RETAIN" } } }
    }]
  });
  assert.deepEqual(message.images, ["https://example.com/top.png"]);
  assert.deepEqual(message.audioSources, []);
  assert.deepEqual(message.remoteAttachments, []);
  const parts = flatten(message.contentParts!);
  assert.ok(parts.some(part => part.kind === "image" && part.source === "https://example.com/nested.png"));
  assert.ok(parts.some(part => part.kind === "audio" && part.source === "https://example.com/audio.wav"));
  assert.ok(parts.some(part => part.kind === "remote_file" && part.sourceName === "报告.pdf"));
  const summary = parts.find(part => part.kind === "special");
  assert.equal(summary?.kind === "special" ? summary.summary : "", "小程序\ntitle: 引用标题");
  assert.equal(JSON.stringify(message.contentParts).includes("SECRET"), false);
  assert.equal(JSON.stringify(message.contentParts).includes("DO-NOT-RETAIN"), false);
});

test("a reference without supplied contents is explicit and never invents a OneBot forward id", () => {
  const message = decode({ message_scene: { ext: ["ref_msg_idx=missing-reference"] } });
  assert.deepEqual(message.contentParts?.at(-1), { kind: "reply", messageId: "missing-reference" });
  assert.deepEqual(message.forwardIds, []);
});

test("embedded trees have bounded depth, node count, text and media with explicit truncation", () => {
  const chain: Record<string, unknown> = { content: "最深正文" };
  let current = chain;
  for (let index = 0; index < 40; index += 1) {
    const child = { content: `层级${index}`, msg_elements: [] as Record<string, unknown>[] };
    current.msg_elements = [child]; current = child;
  }
  const deep = decodeQqMessageContent({ content: "顶层请求", message_type: 102, msg_elements: [chain] });
  assert.equal(deep.parts[0]?.kind === "text" ? deep.parts[0].text : "", "顶层请求");
  assert.ok(flatten(deep.parts).some(part => part.kind === "embedded_message" && part.truncated));
  assert.ok(flatten(deep.parts).filter(part => part.kind === "embedded_message").length <= QQ_EMBEDDED_LIMITS.depth + 1);

  const wide = decodeQqMessageContent({ content: "顶层请求", message_type: 102,
    msg_elements: Array.from({ length: 500 }, () => ({ content: "x".repeat(500), attachments: [{ url: "https://example.com/image.png", content_type: "image/png" }] })) });
  const parts = flatten(wide.parts);
  assert.ok(parts.filter(part => part.kind === "embedded_message").length <= QQ_EMBEDDED_LIMITS.nodes + 1);
  assert.ok(parts.filter(part => part.kind === "image").length <= QQ_EMBEDDED_LIMITS.media);
  assert.ok(parts.reduce((sum, part) => sum + (part.kind === "text" ? part.text.length : 0), 0) <= QQ_EMBEDDED_LIMITS.textCharacters);
  assert.ok(parts.some(part => part.kind === "embedded_message" && part.truncated));
});

test("cyclic and malformed embedded input cannot recurse forever or forge message metadata", () => {
  const cyclic: Record<string, unknown> = { content: "合法正文", msg_idx: "legitimate-index" };
  cyclic.msg_elements = [cyclic];
  const result = decodeQqMessageContent({ content: "顶层请求", msg_elements: [null, 42, "text", cyclic] });
  const parts = flatten(result.parts);
  assert.ok(parts.some(part => part.kind === "embedded_message" && part.truncated));
  assert.ok(parts.some(part => part.kind === "text" && part.text === "合法正文"));
  assert.equal(JSON.stringify(result).includes("[object Object]"), false);
});

test("root request text and repeated cyclic references share the decoder budgets", () => {
  const long = decodeQqMessageContent({ content: "字".repeat(QQ_EMBEDDED_LIMITS.textCharacters + 1) });
  assert.equal(long.text.length, QQ_EMBEDDED_LIMITS.textCharacters);
  assert.equal(long.parts[0]?.kind === "text" ? long.parts[0].text : "", long.text);
  assert.ok(long.parts.some(part => part.kind === "special" && part.segmentType === "qq_message_truncated"));

  const cyclic: Record<string, unknown> = { content: "记录" };
  cyclic.msg_elements = Array.from({ length: 200 }, () => cyclic);
  const result = decodeQqMessageContent({ msg_elements: Array.from({ length: 200 }, () => cyclic) });
  const embedded = flatten(result.parts).filter(part => part.kind === "embedded_message");
  assert.ok(embedded.length <= QQ_EMBEDDED_LIMITS.nodes + 1);
  assert.ok(embedded.some(part => part.truncated));
});

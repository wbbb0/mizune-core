import test from "node:test";
import assert from "node:assert/strict";
import { decodeQqMessage } from "../../../src/services/qqOfficial/eventDecoder.ts";
import { QqReplyPermitRegistry } from "../../../src/services/qqOfficial/replyPermit.ts";
import { resolveDispatchableDirectCommand } from "../../../src/app/messaging/directCommands.ts";

const decode = (content: string, extra: Record<string, unknown> = {}, type = "GROUP_AT_MESSAGE_CREATE") => decodeQqMessage(type, {
  id: "cmd", timestamp: new Date().toISOString(), group_openid: "group", author: { member_openid: "member" },
  content, mentions: [{ id: "self", is_you: true }], ...extra
}, new QqReplyPermitRegistry("qq_official.app"), { selfId: "self", groupContext: "all_received" })!;

for (const content of ["<@self> 。context", "。context <@self>", "<@!self> .context", "<@self>　。context"]) {
  test(`official owner command recognizes platform addressing: ${content}`, () => {
    const incoming = decode(content);
    assert.equal(incoming.message.text, content.includes(".context") ? ".context" : "。context");
    const command = resolveDispatchableDirectCommand({ phase: "chat", setupState: "ready", chatType: "group", relationship: "owner",
      isAtMentioned: incoming.message.isAtMentioned, text: incoming.message.text, hasImages: false, hasAudio: false, hasForwards: false, sessionModeId: "assistant" });
    assert.equal(command?.name, "context");
    assert.ok(incoming.message.contentParts?.some(part => part.kind === "mention" && part.target === "self"));
  });
}

test("mention normalization never promotes quoted commands, literal mentions, or known members to owner commands", () => {
  const quote = decode("<@self>", { msg_elements: [{ content: "。context" }] });
  assert.equal(quote.message.text, "");
  const forged = decode("<@self> 。context", { mentions: [] }, "GROUP_MESSAGE_CREATE");
  assert.equal(forged.contextOnly, true);
  const known = decode("<@self> 。context");
  assert.equal(resolveDispatchableDirectCommand({ phase: "chat", setupState: "ready", chatType: "group", relationship: "known",
    isAtMentioned: true, text: known.message.text, hasImages: false, hasAudio: false, hasForwards: false, sessionModeId: "assistant" }), null);
  assert.equal(decode("<@unlisted> 。context").message.text, "<@unlisted> 。context");
});

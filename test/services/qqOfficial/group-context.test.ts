import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { QqOfficialClient } from "../../../src/services/qqOfficial/client.ts";
import { decodeQqMessage } from "../../../src/services/qqOfficial/eventDecoder.ts";
import { QqReplyPermitRegistry } from "../../../src/services/qqOfficial/replyPermit.ts";

const config = { appId: "app", appSecret: "test", groupContext: "all_received" as const };
const logger = pino({ level: "silent" });
function event(extra: Record<string, unknown> = {}) {
  return { id: "message", author: { member_openid: "sender" }, group_openid: "group",
    content: "普通群聊正文", timestamp: new Date().toISOString(), ...extra };
}
function ready(client: QqOfficialClient) {
  client.acceptEvent("READY", { session_id: "gateway-session", user: { id: "self-bot" } });
}

test("default mode discards full-group events while all_received emits context without a reply permit", () => {
  const restricted = new QqOfficialClient({ ...config, groupContext: "mentions_only" }, logger);
  assert.equal(restricted.acceptEvent("GROUP_MESSAGE_CREATE", event()), null);
  const client = new QqOfficialClient(config, logger);
  const input = client.acceptEvent("GROUP_MESSAGE_CREATE", event());
  assert.ok(input?.contextOnly);
  assert.equal(input.permit, undefined);
  assert.equal(input.message.replyContext, undefined);
  assert.equal(input.message.isAtMentioned, false);
  assert.equal(input.message.text, "普通群聊正文");
});

test("full-group events only activate for trusted self mentions, not text or another bot", () => {
  const client = new QqOfficialClient(config, logger);
  ready(client);
  const textOnly = client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "text-only", content: "<@self-bot>" }));
  assert.equal(textOnly?.contextOnly, true);
  const otherBot = client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "other-bot", mentions: [{ id: "different-bot", bot: true }] }));
  assert.equal(otherBot?.contextOnly, true);
  const everyone = client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "all", mentions: [{ id: "self-bot", scope: "all" }] }));
  assert.equal(everyone?.contextOnly, true);
  const addressed = client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "self", mentions: [{ id: "self-bot", bot: true }] }));
  assert.equal(addressed?.contextOnly, false);
  assert.equal(addressed?.message.isAtMentioned, true);
  assert.equal(addressed?.permit?.messageId, "self");
  const explicit = client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "explicit", mentions: [{ id: "platform-specific-id", is_you: true }] }));
  assert.equal(explicit?.contextOnly, false);
});

test("self id is only established by READY and nested quotes cannot activate a context event", () => {
  const client = new QqOfficialClient(config, logger);
  assert.equal(client.acceptEvent("GROUP_MESSAGE_CREATE", event({ mentions: [{ id: "self-bot" }] }))?.contextOnly, true);
  ready(client);
  const nested = client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "nested", msg_elements: [{ mentions: [{ id: "self-bot", is_you: true }], content: "<@self-bot>" }] }));
  assert.equal(nested?.contextOnly, true);
  assert.equal(client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "self-authored", author: { member_openid: "self-bot" } })), null);
});

test("transport forwards context and activation deliveries to durable runtime admission", () => {
  const client = new QqOfficialClient(config, logger);
  const first = client.acceptEvent("GROUP_MESSAGE_CREATE", event());
  assert.equal(first?.contextOnly, true);
  const upgrade = client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event());
  assert.equal(upgrade?.contextOnly, false);
  assert.equal(upgrade?.message.sourceRef.messageId, first?.message.sourceRef.messageId);
  assert.equal(client.acceptEvent("GROUP_MESSAGE_CREATE", event())?.contextOnly, true);
  assert.equal(client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event())?.contextOnly, false);
});

test("transport preserves AT-first and full-only addressing across event types", () => {
  const client = new QqOfficialClient(config, logger);
  ready(client);
  assert.equal(client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event())?.contextOnly, false);
  assert.equal(client.acceptEvent("GROUP_MESSAGE_CREATE", event())?.contextOnly, true);
  const full = client.acceptEvent("GROUP_MESSAGE_CREATE", event({ id: "full", mentions: [{ member_openid: "self-bot" }] }));
  assert.equal(full?.contextOnly, false);
  assert.equal(client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event({ id: "full" }))?.contextOnly, false);
});

test("raw diagnostics cover ignored full events and callback failures cannot interrupt ingress", () => {
  const observed: string[] = [];
  const client = new QqOfficialClient({ appId: "app", appSecret: "test" }, logger, {
    onIncomingEvent(type) { observed.push(type); throw new Error("diagnostic failure"); }
  });
  assert.equal(client.acceptEvent("GROUP_MESSAGE_CREATE", event()), null);
  assert.ok(client.acceptEvent("GROUP_AT_MESSAGE_CREATE", event()));
  assert.deepEqual(observed, ["GROUP_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"]);
});

test("old context events may be recorded but cannot acquire expired reply authorization", () => {
  const registry = new QqReplyPermitRegistry("qq_official.app");
  const old = event({ timestamp: new Date(Date.now() - 10 * 60_000).toISOString() });
  assert.equal(decodeQqMessage("GROUP_MESSAGE_CREATE", old, registry, { groupContext: "all_received" })?.contextOnly, true);
  assert.equal(decodeQqMessage("GROUP_AT_MESSAGE_CREATE", old, registry), null);
  const oldMention = decodeQqMessage("GROUP_MESSAGE_CREATE", { ...old, mentions: [{ is_you: true }] }, registry, { groupContext: "all_received" });
  assert.equal(oldMention?.contextOnly, true);
  assert.equal(oldMention?.permit, undefined);
  assert.equal(oldMention?.message.isAtMentioned, true);
});

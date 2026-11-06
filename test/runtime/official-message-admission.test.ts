import assert from "node:assert/strict";
import test from "node:test";
import { isOfficialMessageAllowed } from "../../src/app/runtime/officialMessageAdmission.ts";
import { decodeQqMessage } from "../../src/services/qqOfficial/eventDecoder.ts";
import { QqReplyPermitRegistry } from "../../src/services/qqOfficial/replyPermit.ts";

test("official admission uses scoped group identities and rejects non-addressed group input before processing", () => {
  const registry = new QqReplyPermitRegistry("qq_official.app");
  const incoming = decodeQqMessage("GROUP_AT_MESSAGE_CREATE", {
    id: "opaque", group_openid: "group", author: { member_openid: "member" },
    timestamp: new Date().toISOString(), content: "你好"
  }, registry)!.message;
  const whitelist = { hasUser: () => false, hasGroup: () => false };
  const queries: unknown[] = [];
  const identities = { hasOwnerIdentitySync: () => false, findInternalUserIdSync(input: unknown) { queries.push(input); return "owner"; } };
  assert.equal(isOfficialMessageAllowed(incoming, true, whitelist, identities), true);
  assert.deepEqual(queries[0], { channelId: "qq_official.app.group.group", scope: "group_member", externalId: "member" });
  assert.equal(isOfficialMessageAllowed({ ...incoming, isAtMentioned: false }, false, whitelist, identities), false);
  const { replyContext: _permit, ...withoutPermit } = incoming;
  assert.equal(isOfficialMessageAllowed(withoutPermit, false, whitelist, identities), false);
});

test("full-group context requires an explicit context option and never supplies a reply permit", () => {
  const registry = new QqReplyPermitRegistry("qq_official.app");
  const incoming = decodeQqMessage("GROUP_MESSAGE_CREATE", {
    id: "opaque", group_openid: "group", author: { member_openid: "member" },
    timestamp: new Date().toISOString(), content: "普通群聊正文"
  }, registry, { groupContext: "all_received" })!.message;
  const whitelist = { hasUser: () => false, hasGroup: () => false };
  const identities = { hasOwnerIdentitySync: () => false, findInternalUserIdSync: () => undefined };
  assert.equal(isOfficialMessageAllowed(incoming, false, whitelist, identities), false);
  assert.equal(isOfficialMessageAllowed(incoming, false, whitelist, identities, { allowGroupContext: true }), true);
  assert.equal(isOfficialMessageAllowed(incoming, true, whitelist, identities, { allowGroupContext: true }), false);
  assert.equal(isOfficialMessageAllowed(incoming, true, { ...whitelist, hasGroup: () => true }, identities, { allowGroupContext: true }), true);
  assert.equal(incoming.replyContext, undefined);
});

test("空白名单仅对无 owner 的纯文本私聊认领开放，其他消息仍拒绝", () => {
  const message = decodeQqMessage("C2C_MESSAGE_CREATE", {
    id: "own", author: { user_openid: "opaque_user" }, content: ".own", timestamp: new Date().toISOString()
  }, new QqReplyPermitRegistry("qq_official.app"))!.message;
  const whitelist = { hasUser: () => false, hasGroup: () => false };
  const identities = { hasOwnerIdentitySync: () => false, findInternalUserIdSync: () => undefined };
  assert.equal(isOfficialMessageAllowed(message, true, whitelist, identities), true);
  assert.equal(isOfficialMessageAllowed({ ...message, text: "你好" }, true, whitelist, identities), false);
  assert.equal(isOfficialMessageAllowed(message, true, whitelist, { ...identities, hasOwnerIdentitySync: () => true }), false);
  assert.equal(isOfficialMessageAllowed({ ...message, images: ["image"] }, true, whitelist, identities), false);
  const { replyContext: _permit, ...withoutPermit } = message;
  assert.equal(isOfficialMessageAllowed(withoutPermit, true, whitelist, identities), false);
});

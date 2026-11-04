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
  const identities = { findInternalUserIdSync(input: unknown) { queries.push(input); return "owner"; } };
  assert.equal(isOfficialMessageAllowed(incoming, true, whitelist, identities), true);
  assert.deepEqual(queries[0], { channelId: "qq_official.app.group.group", scope: "group_member", externalId: "member" });
  assert.equal(isOfficialMessageAllowed({ ...incoming, isAtMentioned: false }, false, whitelist, identities), false);
  const { replyContext: _permit, ...withoutPermit } = incoming;
  assert.equal(isOfficialMessageAllowed(withoutPermit, false, whitelist, identities), false);
});

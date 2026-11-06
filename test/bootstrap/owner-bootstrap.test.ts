import pino from "pino";
import test from "node:test";
import assert from "node:assert/strict";
import { oneBotOwnerBootstrapTransport, officialOwnerBootstrapTransport } from "../../src/app/runtime/ownerBootstrapTransport.ts";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { UserIdentityStore } from "../../src/identity/userIdentityStore.ts";
import { createOwnerBootstrapFixture as fixture } from "../helpers/owner-bootstrap-fixtures.ts";

for (const platform of ["onebot", "official"] as const) test(`${platform} 首次认领共用初始化推进和已绑定禁用规则`, async t => {
  const f = await fixture(t);
  const request = platform === "onebot" ? { ...f.request, channelId: "acc", requesterUserId: "10001", targetUserId: "10001" } : f.request;
  const transport = platform === "onebot" ? oneBotOwnerBootstrapTransport(f.oneBot) : f.transport;
  assert.equal(await f.service.isAvailable(), true);
  assert.match(await f.service.assignOwner(request, transport), /已将你设为管理者/);
  assert.equal(await f.identities.findInternalUserId({ channelId: request.channelId, externalId: request.targetUserId, scope: "private_user" }), "owner");
  assert.equal((await f.setup.get()).state, "needs_persona");
  assert.equal(await f.service.isAvailable(), false);
  assert.match(await f.service.assignOwner(request, transport), /不再可用/);
  assert.equal(f.sent.length, 1);
});

test("首次认领可提升已有私聊身份，保留群成员作用域及创建时间", async t => {
  const f = await fixture(t);
  const existing = await f.identities.ensureUserIdentity({ channelId: f.request.channelId, externalId: f.request.targetUserId });
  const group = await f.identities.ensureUserIdentity({ channelId: f.request.channelId + ".group.g", externalId: f.request.targetUserId, scope: "group_member" });
  assert.match(await f.service.assignOwner(f.request, f.transport), /已将你设为管理者/);
  const owner = await f.identities.getRow({ channelId: f.request.channelId, externalId: f.request.targetUserId, scope: "private_user" });
  assert.equal(owner?.createdAt, existing.createdAt);
  assert.equal(owner?.internalUserId, "owner");
  assert.equal((await f.identities.getRow(group))?.internalUserId, group.internalUserId);
});

test("不同连接和数据库访问者并发首次认领只允许一个 owner", async t => {
  const f = await fixture(t);
  const otherDb = new StateDatabase(f.dir, pino({ level: "silent" }));
  const other = new UserIdentityStore(f.dir, pino({ level: "silent" }), otherDb); await other.init();
  try {
    const results = await Promise.all([
      f.identities.claimInitialOwnerIdentity({ channelId: "qq_official.app", externalId: "opaque" }),
      other.claimInitialOwnerIdentity({ channelId: "acc", externalId: "10001" })
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await f.identities.list()).filter(x => x.internalUserId === "owner").length, 1);
  } finally { otherDb.close(); }
});

test("群聊、其他官方账号、其他连接和伪造授权均不可认领", async t => {
  const f = await fixture(t);
  assert.match(await f.service.assignOwner({ ...f.request, chatType: "group" }, f.transport), /只能在机器人私聊/);
  assert.match(await f.service.assignOwner({ ...f.request, targetUserId: "another" }, f.transport), /只能通过当前私聊验证本人/);
  assert.match(await f.service.assignOwner({ ...f.request, channelId: "qq_official.other" }, f.transport), /当前官方机器人/);
  const forged = officialOwnerBootstrapTransport({ client: f.official, replyContext: { ...f.permit }, messaging: f.messaging, sessionId: "qq_official.app:p:opaque_user" });
  await assert.rejects(f.service.assignOwner(f.request, forged), /invalid_reply_permit/);
  const expired = f.official.permits.issue({ chatType: "private", targetId: "opaque_user", messageId: "expired", timestampMs: Date.now() - 300001 });
  const expiredTransport = officialOwnerBootstrapTransport({ client: f.official, replyContext: expired, messaging: f.messaging, sessionId: "qq_official.app:p:opaque_user" });
  await assert.rejects(f.service.assignOwner(f.request, expiredTransport), /reply_permit_expired/);
  assert.equal(await f.identities.hasOwnerIdentity(), false);
  assert.equal(f.sent.length, 0);
});

test("OneBot 指定好友保留原平台通知，并拒绝非好友", async t => {
  const f = await fixture(t);
  const transport = oneBotOwnerBootstrapTransport(f.oneBot);
  assert.match(await f.service.assignOwner({ ...f.request, channelId: "acc", targetUserId: "999" }, transport), /好友关系/);
  assert.match(await f.service.assignOwner({ ...f.request, channelId: "acc", targetUserId: "10002" }, transport), /已将 10002/);
  assert.deepEqual(f.sent, [{ userId: "10002", text: "请确认基础人格。" }]);
});

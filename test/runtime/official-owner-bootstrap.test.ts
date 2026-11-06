import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createOwnerBootstrapFixture } from "../helpers/owner-bootstrap-fixtures.ts";
import { withMediaServices } from "../helpers/media-import-fixtures.ts";
import { createRuntimeMessageIngress } from "../../src/app/runtime/messageIngress.ts";
import { receiveOfficialMessage } from "../../src/app/runtime/officialMessageIngress.ts";
import { IncomingMessageReceiptStore } from "../../src/data/state/incomingMessageReceiptStore.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";

// Exercise admission -> durable receipt -> real runtime command dispatch -> shared owner service.
test("官方首次私聊 own 经真实消息入口绑定 owner，不调用 OneBot 或模型，重复事件不重复执行", async t => {
  const f = await createOwnerBootstrapFixture(t);
  const manager = new SessionManager(f.config);
  const forbidden = () => { throw new Error("官方认领不应调用 OneBot 或模型"); };
  const services = withMediaServices({
    config: f.config, logger: pino({ level: "silent" }), sessionManager: manager,
    setupStore: f.setup, userIdentityStore: f.identities, userStore: f.users,
    audioStore: { registerSources: async () => [] }, chatFileStore: { importRemoteSource: forbidden },
    messaging: f.messaging
  });
  const ingress = createRuntimeMessageIngress({
    services, persistSession: () => {}, directCommandDeps: {
      ...services, oneBotClient: { getFriendList: forbidden, sendText: forbidden }, qqOfficialClient: f.official,
      messaging: f.messaging, onebotSendImmediateText: forbidden, flushSession: forbidden, persistSession: () => {},
      assignOwner: f.service.assignOwner, isOwnerAssignmentAvailable: f.service.isAvailable
    }
  } as unknown as Parameters<typeof createRuntimeMessageIngress>[0]);
  const event = f.official.acceptEvent("C2C_MESSAGE_CREATE", {
    id: "own", author: { user_openid: "opaque_user" }, content: ".own", timestamp: new Date().toISOString()
  });
  assert(event);
  const receive = () => receiveOfficialMessage({
    receipts: new IncomingMessageReceiptStore(f.db), whitelistEnabled: true, allowGroupContext: false,
    whitelist: { hasGroup: () => false, hasUser: () => false }, identities: f.identities,
    handleIncomingMessage: ingress.handleIncomingMessage
  }, event);
  await receive();
  assert.equal(await f.identities.findInternalUserId({ channelId: "qq_official.app", externalId: "opaque_user" }), "owner");
  assert.equal(f.sent.length, 2);
  assert.equal((await f.setup.get()).state, "needs_persona");
  const session = manager.getSession("qq_official.app:p:opaque_user");
  assert.equal(session.source, "qq_official");
  assert.equal(session.pendingMessages.length, 0);
  assert(session.internalTranscript.some(item => item.kind === "direct_command" && item.direction === "input" && item.sourceRef?.messageId === "own"));
  await receive();
  assert.equal(f.sent.length, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { receiveOfficialMessage } from "../../src/app/runtime/officialMessageIngress.ts";
import { processIncomingMessage } from "../../src/app/messaging/messageEventHandler.ts";
import { createDirectCommandHandler } from "../../src/app/messaging/directCommands.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import { toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { IncomingMessageReceiptStore } from "../../src/data/state/incomingMessageReceiptStore.ts";
import { createInitialScenarioHostSessionState } from "../../src/modes/scenarioHost/types.ts";
import { QqReplyPermitRegistry } from "../../src/services/qqOfficial/replyPermit.ts";
import { decodeQqMessage } from "../../src/services/qqOfficial/eventDecoder.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { MessageEventHandlerDeps } from "../../src/app/messaging/messageHandlerTypes.ts";
import type { QqOfficialIncoming } from "../../src/services/qqOfficial/eventDecoder.ts";

const logger = pino({ level: "silent" });

function incoming(command = "clear", contextOnly = false, messageId = "message", connectionId = "qq_official.test-app"): QqOfficialIncoming {
  const privateMessage = command === "reset";
  const decoded = decodeQqMessage(contextOnly ? "GROUP_MESSAGE_CREATE" : privateMessage ? "C2C_MESSAGE_CREATE" : "GROUP_AT_MESSAGE_CREATE", {
    id: messageId, group_openid: "group", author: { member_openid: "member", user_openid: "member" },
    content: `.${command}`, timestamp: new Date().toISOString()
  }, new QqReplyPermitRegistry(connectionId), { groupContext: "all_received" });
  assert.ok(decoded);
  return decoded;
}

const admission = {
  whitelistEnabled: false, allowGroupContext: true,
  whitelist: { hasGroup: () => false, hasUser: () => false },
  identities: { findInternalUserIdSync: () => "owner" }
};

for (const scenario of ["clear-first", "clear-after-context", "reset-first", "clear-fails-after-effect"] as const) {
  test(`durable runtime receipts survive real command history clearing and restart: ${scenario}`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "official-receipt-runtime-"));
    let state = new StateDatabase(dataDir, logger);
    try {
      await state.init();
      let receipts = new IncomingMessageReceiptStore(state);
      const config = createTestAppConfig({ dataDir });
      let manager = new SessionManager(config);
      const command = scenario === "reset-first" ? "reset" : "clear";
      const message = incoming(command);
      const sessionId = command === "reset" ? "qq_official.test-app:p:member" : "qq_official.test-app:g:group";
      const session = manager.ensureSession({ id: sessionId, type: command === "reset" ? "private" : "group", source: "qq_official" });
      if (command === "reset") session.modeId = "scenario_host";
      manager.appendUserHistory(sessionId, { chatType: session.type, userId: "owner", senderName: "合成发送者", text: "清空前的合成历史" });
      let executions = 0;
      let replies = 0;
      const forbidden = () => { throw new Error("command ingress must not schedule ordinary model work"); };
      const deps = (): MessageEventHandlerDeps => {
        const realCommand = createDirectCommandHandler({
          config, sessionManager: manager, logger, persistSession: () => {},
          sendImmediateText: async () => { replies += 1; },
          scenarioHostStateStore: {
            ensure: async (_id: string, defaults: { playerUserId: string; playerDisplayName: string }) => createInitialScenarioHostSessionState(defaults),
            write: async () => {}
          }
        } as unknown as Parameters<typeof createDirectCommandHandler>[0]);
        return {
          inboundDelivery: "qq_official",
          services: {
            config, sessionManager: manager, logger,
            audioStore: { registerSources: async () => [] }, chatFileStore: { importRemoteSource: forbidden },
            userIdentityStore: { ensureUserIdentity: async () => ({ internalUserId: "owner" }) },
            userStore: { touchSeenUser: async () => ({ relationship: "owner" }) },
            setupStore: { get: async () => ({ state: "ready" }) }
          },
          handleDirectCommand: async (input: Parameters<typeof realCommand>[0]) => {
            executions += 1;
            await realCommand(input);
            if (scenario === "clear-fails-after-effect") throw new Error("synthetic post-effect failure");
          },
          persistSession: () => {}, sendImmediateText: forbidden, flushSession: forbidden
        } as unknown as MessageEventHandlerDeps;
      };
      const receive = (event: QqOfficialIncoming) => receiveOfficialMessage({
        ...admission, receipts, handleIncomingMessage: message => processIncomingMessage(deps(), message)
      }, event);

      if (scenario === "clear-after-context") await receive(incoming(command, true));
      if (scenario === "clear-fails-after-effect") await assert.rejects(receive(message), /synthetic post-effect failure/);
      else await receive(message);
      assert.equal(executions, 1);
      assert.equal(replies, 1);
      assert.equal(session.internalTranscript.length, 0);
      assert.equal(session.pendingMessages.length, 0);
      assert.equal(manager.hasHistorySource(sessionId, message.message.sourceRef), false);
      await receive(message);
      if (command === "clear") await receive(incoming(command, true));
      assert.equal(executions, 1);
      assert.equal(session.internalTranscript.length, 0);

      const persistence = new SessionPersistence(dataDir, logger);
      await persistence.init();
      await persistence.save(toPersistedSessionState(session));
      const saved = await persistence.loadAll();
      state.close();
      state = new StateDatabase(dataDir, logger);
      await state.init();
      receipts = new IncomingMessageReceiptStore(state);
      manager = new SessionManager(config);
      manager.restoreSessions(saved);
      manager.appendUserHistory(sessionId, {
        chatType: session.type, userId: "owner", senderName: "合成发送者", text: "清空后新消息"
      });
      await receive(message);
      if (command === "clear") await receive(incoming(command, true));
      assert.equal(executions, 1);
      const afterReplay = manager.getSession(sessionId).internalTranscript;
      assert.equal(afterReplay.length, 1);
      assert.equal(afterReplay[0]?.kind === "user_message" && afterReplay[0].text, "清空后新消息");

      // A consumed source must not prevent a different connection using the same message id.
      const accepted: string[] = [];
      await receiveOfficialMessage({ ...admission, receipts, handleIncomingMessage: async message => {
        accepted.push(message.sourceRef!.connectionId);
      } }, incoming(command, false, "message", "qq_official.other-app"));
      assert.deepEqual(accepted, ["qq_official.other-app"]);
    } finally {
      state.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

test("runtime admission rejects before claiming, and receipt failure blocks all processing", async () => {
  let claims = 0;
  let handled = 0;
  const dependencies = {
    ...admission,
    receipts: { claim() { claims += 1; throw new Error("synthetic receipt failure"); } },
    handleIncomingMessage: async () => { handled += 1; }
  };
  await receiveOfficialMessage({ ...dependencies, whitelistEnabled: true, identities: { findInternalUserIdSync: () => undefined } }, incoming());
  assert.equal(claims, 0);
  await assert.rejects(receiveOfficialMessage(dependencies, incoming()), /synthetic receipt failure/);
  assert.equal(claims, 1);
  assert.equal(handled, 0);
});

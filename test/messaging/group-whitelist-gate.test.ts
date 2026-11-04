import test from "node:test";
import assert from "node:assert/strict";
import { resolveTriggerDecision } from "../../src/app/messaging/messageTriggerFlow.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { ParsedIncomingMessage } from "../../src/services/messaging/incomingMessage.ts";

for (const source of ["onebot", "qq_official"] as const) {
  for (const whitelistEnabled of [false, true]) {
    for (const mentioned of [false, true]) {
      test(`${source}: whitelist=${whitelistEnabled}, mentioned=${mentioned} honors both independent gates`, async () => {
        const config = createTestAppConfig({ whitelist: { enabled: whitelistEnabled } });
        const manager = new SessionManager(config);
        const message: ParsedIncomingMessage = {
          source, channelId: source === "qq_official" ? "qq_official.app" : "onebot-test",
          chatType: "group", groupId: "group", userId: "member", senderName: "成员", text: "测试",
          images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [],
          forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: mentioned
        };
        const session = manager.getOrCreateSession(message);
        const services = {
          config, sessionManager: manager,
          whitelistStore: { hasUser: () => false, hasGroup: () => false },
          conversationAccess: { recordSeenGroupMember: async () => {} }
        } as unknown as Parameters<typeof resolveTriggerDecision>[0];
        const context = { session, user: { relationship: "known" }, setupState: { state: "ready" }, enrichedMessage: message } as unknown as Parameters<typeof resolveTriggerDecision>[1];
        const decision = await resolveTriggerDecision(services, context);
        assert.equal(decision.shouldTriggerResponse, !whitelistEnabled && mentioned);
        assert.equal(decision.directlyAddressed, mentioned);
        assert.equal(decision.threadAction, !whitelistEnabled && mentioned ? "reply_now" : "record_only");
      });
    }
  }
}

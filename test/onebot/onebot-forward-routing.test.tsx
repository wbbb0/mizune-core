import test from "node:test";
import assert from "node:assert/strict";
import { EventRouter } from "../../src/services/onebot/eventRouter.ts";
import { normalizeOneBotMessageId } from "../../src/services/onebot/messageId.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { forwardToolHandlers } from "../../src/llm/tools/conversation/forwardTools.ts";
import { messageToolHandlers } from "../../src/llm/tools/conversation/messageTools.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";

  test("event router keeps forward ids even without text or images", async () => {
    const config = createForwardFeatureConfig();
    const router = new EventRouter(config, config.configRuntime.instanceName);
    const parsed = router.toIncomingMessage({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 1,
      user_id: 10001,
      message: [{ type: "forward", data: { id: "forward-123" } }],
      raw_message: "[CQ:forward,id=forward-123]",
      sender: { user_id: 10001, nickname: "Tester" },
      self_id: 20002,
      time: Math.floor(Date.now() / 1000)
    });

    assert.equal(parsed?.text, "");
    assert.deepEqual(parsed?.images, []);
    assert.deepEqual(parsed?.forwardIds, ["forward-123"]);
  });

  test("event router keeps reply and mention references without text", async () => {
    const config = createForwardFeatureConfig();
    const router = new EventRouter(config, config.configRuntime.instanceName);
    const parsed = router.toIncomingMessage({
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: 2,
      user_id: 10001,
      group_id: 30001,
      message: [
        { type: "reply", data: { id: "987654" } },
        { type: "at", data: { qq: "20002" } },
        { type: "at", data: { qq: "30003" } },
        { type: "at", data: { qq: "all" } }
      ],
      raw_message: "[CQ:reply,id=987654][CQ:at,qq=20002][CQ:at,qq=30003][CQ:at,qq=all]",
      sender: { user_id: 10001, nickname: "Tester" },
      self_id: 20002,
      time: Math.floor(Date.now() / 1000)
    });

    assert.equal(parsed?.text, "");
    assert.equal(parsed?.replyMessageId, "987654");
    assert.deepEqual(parsed?.mentionUserIds, ["30003"]);
    assert.equal(parsed?.mentionedAll, true);
    assert.equal(parsed?.isAtMentioned, true);
  });

  test("event router keeps emoji sources separate from normal images", async () => {
    const config = createForwardFeatureConfig();
    const router = new EventRouter(config, config.configRuntime.instanceName);
    const parsed = router.toIncomingMessage({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 3,
      user_id: 10001,
      message: [
        { type: "mface", data: { url: "https://example.com/emoji.gif" } },
        { type: "image", data: { url: "https://example.com/pic.png" } }
      ],
      raw_message: "[CQ:mface,url=https://example.com/emoji.gif][CQ:image,url=https://example.com/pic.png]",
      sender: { user_id: 10001, nickname: "Tester" },
      self_id: 20002,
      time: Math.floor(Date.now() / 1000)
    });

    assert.deepEqual(parsed?.images, ["https://example.com/emoji.gif", "https://example.com/pic.png"]);
    assert.deepEqual(parsed?.emojiSources, ["https://example.com/emoji.gif"]);
    assert.deepEqual(parsed?.attachments, []);
  });

  test("view_forward_record repairs rounded forward_id from recent session refs", async () => {
    const sessionManager = new SessionManager(createForwardFeatureConfig());
    sessionManager.ensureSession({ id: "qqbot:p:owner", type: "private" });
    sessionManager.appendUserHistory("qqbot:p:owner", {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "",
      forwardIds: ["7618168520610781740"]
    });

    let capturedForwardId: string | null = null;
    const result = await forwardToolHandlers.view_forward_record!(
      { id: "tool_forward_1", type: "function", function: { name: "view_forward_record", arguments: "{\"forward_id\":7618168520610782000}" } },
      { forward_id: "7618168520610782000" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        sessionManager,
        forwardResolver: {
          async resolveForwardRecord(forwardId: string) {
            capturedForwardId = forwardId;
            return { forwardId, fetchedAt: 1, nodes: [] };
          }
        } as any
      } as any
    );

    assert.equal(capturedForwardId, "7618168520610781740");
    assert.equal(JSON.parse(String(result)).forwardId, "7618168520610781740");
  });

  test("view_message repairs rounded message_id from recent session refs", async () => {
    const sessionManager = new SessionManager(createForwardFeatureConfig());
    sessionManager.ensureSession({ id: "qqbot:p:owner", type: "private" });
    sessionManager.appendUserHistory("qqbot:p:owner", {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "",
      replyMessageId: "1234567890123456789"
    });

    let capturedMessageId: string | null = null;
    await messageToolHandlers.view_message!(
      { id: "tool_message_1", type: "function", function: { name: "view_message", arguments: "{\"message_id\":1234567890123456800}" } },
      { message_id: "1234567890123456800" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        sessionManager,
        oneBotClient: {
          async getMessage(messageId: string) {
            capturedMessageId = messageId;
            return {
              message_id: null,
              message_type: "private",
              user_id: null,
              group_id: null,
              message: [],
              sender: {},
              time: null,
              raw_message: ""
            };
          }
        } as any
      } as any
    );

    assert.equal(capturedMessageId, "1234567890123456789");
  });

  test("normalizeOneBotMessageId accepts string send results", async () => {
    assert.equal(normalizeOneBotMessageId("123456"), 123456);
    assert.equal(normalizeOneBotMessageId(123456), 123456);
    assert.equal(normalizeOneBotMessageId(""), null);
    assert.equal(normalizeOneBotMessageId("abc"), null);
  });

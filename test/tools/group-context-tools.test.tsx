import test from "node:test";
import assert from "node:assert/strict";
import { groupContextToolDescriptors, groupContextToolHandlers } from "../../src/llm/tools/conversation/groupContextTools.ts";
import type { LlmToolCall } from "../../src/llm/llmClient.ts";

test("current group tools do not accept explicit group ids", () => {
  for (const descriptor of groupContextToolDescriptors) {
    const properties = descriptor.definition.function.parameters?.properties ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(properties, "groupId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(properties, "group_id"), false);
  }
});

test("view_current_group_info reads the current group from session id", async () => {
  let capturedGroupId = "";
  const result = await groupContextToolHandlers.view_current_group_info!(
    toolCall("view_current_group_info"),
    {},
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupInfo(groupId: string) {
          capturedGroupId = groupId;
          return {
            group_id: Number(groupId),
            group_name: "测试群",
            member_count: 42,
            max_member_count: 500
          };
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(capturedGroupId, "123456");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.groupId, "123456");
  assert.equal(parsed.groupName, "测试群");
  assert.match(parsed.summary, /测试群/);
});

test("current group tools reject private sessions", async () => {
  const result = await groupContextToolHandlers.list_current_group_members!(
    toolCall("list_current_group_members"),
    {},
    {
      lastMessage: { sessionId: "qqbot:p:10001", userId: "10001", senderName: "Alice" },
      oneBotClient: {}
    } as any
  );

  assert.equal(JSON.parse(String(result)).error, "current session is not a group chat");
});

test("list_current_group_members supports query and clamps limit", async () => {
  const result = await groupContextToolHandlers.list_current_group_members!(
    toolCall("list_current_group_members"),
    { query: "ali", limit: 999 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupMemberList(groupId: string) {
          assert.equal(groupId, "123456");
          return [
            { group_id: 123456, user_id: 10001, nickname: "Alice", card: "Ali", role: "member" },
            { group_id: 123456, user_id: 10002, nickname: "Bob", card: "Builder", role: "admin" }
          ];
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.totalMatched, 1);
  assert.equal(parsed.items[0].userId, "10001");
  assert.equal("searchText" in parsed.items[0], false);
});

test("list_current_group_announcements supports query and clamps limit", async () => {
  const result = await groupContextToolHandlers.list_current_group_announcements!(
    toolCall("list_current_group_announcements"),
    { query: "维护", limit: 999 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupAnnouncements(groupId: string) {
          assert.equal(groupId, "123456");
          return [
            { id: "n1", title: "维护通知", content: "今晚维护", sender_id: 10001, publish_time: 1710000000 },
            { id: "n2", title: "活动通知", content: "周末活动", sender_id: 10002, publish_time: 1710000100 }
          ];
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.limit, 30);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.totalMatched, 1);
  assert.equal(parsed.items[0].id, "n1");
  assert.equal(parsed.items[0].content, "今晚维护");
  assert.equal("searchText" in parsed.items[0], false);
});

function toolCall(name: string): LlmToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: {
      name,
      arguments: "{}"
    }
  };
}

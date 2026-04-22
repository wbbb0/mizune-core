import test from "node:test";
import assert from "node:assert/strict";
import { crossChatToolHandlers } from "../../src/llm/tools/conversation/crossChatTools.ts";

import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

  test("delegate_message_to_chat injects natural current-chat phrasing guidance", async () => {
    const createdJobs: any[] = [];
    const result = await crossChatToolHandlers.delegate_message_to_chat!(
      createFunctionToolCall("delegate_message_to_chat", "tool_delegate_1"),
      { sessionId: "qqbot:p:40004", instruction: "帮我问一下对方现在在不在。" },
      {
        relationship: "owner",
        currentUser: { specialRole: "none" } as any,
        npcDirectory: { isNpc() { return false; } } as any,
        oneBotClient: {
          async getFriendList() {
            return [{ user_id: 40004, nickname: "FriendA", remark: "FriendA" }];
          },
          async getGroupList() {
            return [];
          }
        } as any,
        sessionManager: {
          ensureSession() {
            return { id: "qqbot:p:40004", type: "private" };
          }
        } as any,
        scheduledJobStore: {
          async create(job: any) {
            createdJobs.push(job);
            return { ...job, id: "job_1" };
          },
          async remove() {}
        } as any,
        scheduler: {
          async createJob(job: any) {
            createdJobs.push({ scheduled: job.id });
          }
        } as any,
        config: { scheduler: { defaultTimezone: "Asia/Shanghai" } } as any
      } as any
    );

    if (typeof result === "string") {
      throw new Error("expected structured delegate result");
    }
    const parsed = parseJsonToolResult<any>(result.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.replyStyleHint.includes("第一人称"), true);
    assert.ok(result.supplementalMessages);
    const [message] = result.supplementalMessages;
    assert.ok(message);
    assert.equal(result.supplementalMessages.length, 1);
    assert.equal(message.role, "user");
    assert.ok(Array.isArray(message.content));
    const textPart = message.content[0];
    assert.ok(textPart && typeof textPart !== "string");
    assert.equal(textPart.type, "text");
    assert.match(String(textPart.text), /我马上去问问/);
    assert.equal(createdJobs.length, 2);
  });

  test("delegate_message_to_chat rejects npc targets", async () => {
    const result = await crossChatToolHandlers.delegate_message_to_chat!(
      createFunctionToolCall("delegate_message_to_chat", "tool_delegate_2"),
      { sessionId: "qqbot:p:30003", instruction: "帮我问一下。" },
      {
        relationship: "owner",
        currentUser: { specialRole: "none" } as any,
        npcDirectory: {
          isNpc(userId: string) {
            return userId === "30003";
          }
        } as any,
        oneBotClient: {
          async getFriendList() {
            throw new Error("should not be called for npc targets");
          },
          async getGroupList() {
            return [];
          }
        } as any,
        sessionManager: {
          ensureSession() {
            throw new Error("should not create session for npc target");
          }
        } as any,
        scheduledJobStore: {
          async create() {
            throw new Error("should not create job for npc target");
          },
          async remove() {}
        } as any,
        scheduler: {
          async createJob() {
            throw new Error("should not schedule job for npc target");
          }
        } as any,
        config: { scheduler: { defaultTimezone: "Asia/Shanghai" } } as any
      } as any
    );

    assert.equal(typeof result, "string");
    if (typeof result !== "string") {
      throw new Error("expected string tool error");
    }
    assert.match(result, /现在不支持这个功能/);
  });

  test("delegate_message_to_chat resolves private target identity before npc check", async () => {
    const result = await crossChatToolHandlers.delegate_message_to_chat!(
      createFunctionToolCall("delegate_message_to_chat", "tool_delegate_3"),
      { sessionId: "dev:p:2254600711", instruction: "帮我问一下。" },
      {
        relationship: "owner",
        currentUser: { specialRole: "none" } as any,
        npcDirectory: {
          isNpc(userId: string) {
            return userId === "owner";
          }
        } as any,
        userIdentityStore: {
          async findInternalUserId(input: { externalId: string }) {
            return input.externalId === "2254600711" ? "owner" : undefined;
          }
        } as any,
        oneBotClient: {
          async getFriendList() {
            throw new Error("should not be called after npc mapping resolves");
          },
          async getGroupList() {
            return [];
          }
        } as any,
        sessionManager: {
          ensureSession() {
            throw new Error("should not create session for npc target");
          }
        } as any,
        scheduledJobStore: {
          async create() {
            throw new Error("should not create job for npc target");
          },
          async remove() {}
        } as any,
        scheduler: {
          async createJob() {
            throw new Error("should not schedule job for npc target");
          }
        } as any,
        config: { scheduler: { defaultTimezone: "Asia/Shanghai" } } as any
      } as any
    );

    assert.equal(typeof result, "string");
    if (typeof result !== "string") {
      throw new Error("expected string tool error");
    }
    assert.match(result, /现在不支持这个功能/);
  });

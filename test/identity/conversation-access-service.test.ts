import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ConversationAccessService } from "../../src/identity/conversationAccessService.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("private session access resolves external session target to internal requester user id", async () => {
  const sessionManager = new SessionManager(createTestAppConfig());
  const sessionId = "dev:p:2254600711";
  sessionManager.ensureSession({ id: sessionId, type: "private" });

  const service = new ConversationAccessService(
    sessionManager,
    {} as never,
    {
      isNpc() {
        return false;
      }
    } as never,
    {
      async get() {
        return null;
      },
      async remember() {},
      async rememberSeen() {}
    } as never,
    {
      async findInternalUserId(input: { channelId: string; externalId: string }) {
        return input.channelId === "dev" && input.externalId === "2254600711"
          ? "owner"
          : undefined;
      },
      async findIdentityByInternalUserId() {
        return undefined;
      }
    } as never,
    pino({ level: "silent" })
  );

  const visible = await service.canAccessSession("owner", sessionId);
  assert.ok(visible);
  assert.equal(visible?.reason, "self_private");
});

test("private npc session access also resolves external session target to internal npc id", async () => {
  const sessionManager = new SessionManager(createTestAppConfig());
  const sessionId = "dev:p:574066748";
  sessionManager.ensureSession({ id: sessionId, type: "private" });

  const service = new ConversationAccessService(
    sessionManager,
    {} as never,
    {
      isNpc(userId: string) {
        return userId === "npc_1";
      }
    } as never,
    {
      async get() {
        return null;
      },
      async remember() {},
      async rememberSeen() {}
    } as never,
    {
      async findInternalUserId(input: { channelId: string; externalId: string }) {
        return input.channelId === "dev" && input.externalId === "574066748"
          ? "npc_1"
          : undefined;
      },
      async findIdentityByInternalUserId() {
        return undefined;
      }
    } as never,
    pino({ level: "silent" })
  );

  const visible = await service.canAccessSession("owner", sessionId);
  assert.ok(visible);
  assert.equal(visible?.reason, "npc_private");
});

test("shared group access resolves requester external id before querying onebot", async () => {
  const sessionManager = new SessionManager(createTestAppConfig());
  const sessionId = "dev:g:123456";
  sessionManager.ensureSession({ id: sessionId, type: "group" });
  const groupMemberRequests: Array<{ groupId: string; userId: string }> = [];

  const service = new ConversationAccessService(
    sessionManager,
    {
      async getGroupMemberInfo(groupId: string, userId: string) {
        groupMemberRequests.push({ groupId, userId });
        return { group_id: Number(groupId), user_id: Number(userId) };
      }
    } as never,
    {
      isNpc() {
        return false;
      }
    } as never,
    {
      async get() {
        return null;
      },
      async remember() {},
      async rememberSeen() {}
    } as never,
    {
      async findInternalUserId() {
        return undefined;
      },
      async findIdentityByInternalUserId(internalUserId: string) {
        return internalUserId === "owner"
          ? {
              channelId: "dev",
              scope: "private_user",
              externalId: "2254600711",
              internalUserId: "owner",
              createdAt: 1
            }
          : undefined;
      }
    } as never,
    pino({ level: "silent" })
  );

  const visible = await service.canAccessSession("owner", sessionId);
  assert.ok(visible);
  assert.equal(visible?.reason, "shared_group");
  assert.deepEqual(groupMemberRequests, [{ groupId: "123456", userId: "2254600711" }]);
});

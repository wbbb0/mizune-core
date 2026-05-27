import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { UserIdentityStore } from "../../src/identity/userIdentityStore.ts";
import { EventRouter } from "../../src/services/onebot/eventRouter.ts";
import { isOwnerBootstrapCommandText } from "../../src/app/bootstrap/ownerBootstrapPolicy.ts";
import { WhitelistStore } from "../../src/identity/whitelistStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createPrivateMessageEvent(text: string) {
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 1,
    user_id: 10001,
    message: [
      {
        type: "text",
        data: {
          text
        }
      }
    ],
    raw_message: text,
    sender: {
      user_id: 10001,
      nickname: "Tester"
    },
    self_id: 20002,
    time: Math.floor(Date.now() / 1000)
  };
}

function createGroupMessageEvent(text: string, overrides?: { groupId?: number; userId?: number }) {
  return {
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 1,
    group_id: overrides?.groupId ?? 20001,
    user_id: overrides?.userId ?? 10001,
    message: [
      {
        type: "text",
        data: {
          text
        }
      }
    ],
    raw_message: text,
    sender: {
      user_id: overrides?.userId ?? 10001,
      nickname: "Tester"
    },
    self_id: 20002,
    time: Math.floor(Date.now() / 1000)
  };
}

test("whitelist store initializes users and groups from data defaults instead of config", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-whitelist-"));
  try {
    const store = new WhitelistStore(dataDir, pino({ level: "silent" }));

    await store.init();

    assert.deepEqual(store.getSnapshot(), { users: [], groups: [] });
    await assert.rejects(
      readFile(join(dataDir, "whitelist.json"), "utf8"),
      { code: "ENOENT" }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("event router allows private .own before owner is bound even when whitelist is enabled", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-identity-router-bootstrap-"));
  const config = createTestAppConfig({
    whitelist: {
      enabled: true
    }
  });
  try {
    const identityStore = new UserIdentityStore(dataDir, pino({ level: "silent" }));
    await identityStore.init();
    const router = new EventRouter(config, config.configRuntime.instanceName, {
      hasUser: () => false
    } as any, identityStore, undefined, isOwnerBootstrapCommandText);

    assert.equal(router.toIncomingMessage(createPrivateMessageEvent(".own") as any)?.text, ".own");
    assert.equal(router.toIncomingMessage(createPrivateMessageEvent("hello") as any), null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("event router allows owner private messages when external identity points to owner", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-identity-router-owner-"));
  try {
    const config = createTestAppConfig({
      whitelist: {
        enabled: true
      }
    });
    const identityStore = new UserIdentityStore(dataDir, pino({ level: "silent" }));
    await identityStore.init();
    await identityStore.bindOwnerIdentity({
      channelId: config.configRuntime.instanceName,
      externalId: "10001"
    });
    const router = new EventRouter(config, config.configRuntime.instanceName, {
      hasUser: () => false
    } as any, identityStore, undefined, isOwnerBootstrapCommandText);

    assert.equal(router.toIncomingMessage(createPrivateMessageEvent("hello") as any)?.text, "hello");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("event router filters non-whitelisted group messages before parsing", async () => {
  const config = createTestAppConfig({
    whitelist: {
      enabled: true
    }
  });
  const router = new EventRouter(config, config.configRuntime.instanceName, {
    hasUser: () => false,
    hasGroup: (groupId: string) => groupId === "20001"
  } as any, undefined, undefined, isOwnerBootstrapCommandText);

  assert.equal(router.toIncomingMessage(createGroupMessageEvent("hello", { groupId: 20002 }) as any), null);
  assert.equal(
    router.toIncomingMessage(createGroupMessageEvent("hello", { groupId: 20001 }) as any)?.groupId,
    "20001"
  );
});

test("event router allows whitelisted users in non-whitelisted groups", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-identity-router-whitelisted-user-group-"));
  try {
    const config = createTestAppConfig({
      whitelist: {
        enabled: true
      }
    });
    const identityStore = new UserIdentityStore(dataDir, pino({ level: "silent" }));
    await identityStore.init();
    await identityStore.ensureUserIdentity({
      channelId: config.configRuntime.instanceName,
      externalId: "10001"
    });
    const internalUserId = identityStore.findInternalUserIdSync({
      channelId: config.configRuntime.instanceName,
      externalId: "10001"
    });
    assert.ok(internalUserId);

    const router = new EventRouter(config, config.configRuntime.instanceName, {
      hasUser(userId: string) {
        return userId === internalUserId;
      },
      hasGroup() {
        return false;
      }
    } as any, identityStore, undefined, isOwnerBootstrapCommandText);

    assert.equal(router.toIncomingMessage(createGroupMessageEvent("hello", { groupId: 20002 }) as any)?.groupId, "20002");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("event router allows owner group messages even when group is not whitelisted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-identity-router-owner-group-"));
  try {
    const config = createTestAppConfig({
      whitelist: {
        enabled: true
      }
    });
    const identityStore = new UserIdentityStore(dataDir, pino({ level: "silent" }));
    await identityStore.init();
    await identityStore.bindOwnerIdentity({
      channelId: config.configRuntime.instanceName,
      externalId: "10001"
    });
    const router = new EventRouter(config, config.configRuntime.instanceName, {
      hasUser: () => false,
      hasGroup: () => false
    } as any, identityStore, undefined, isOwnerBootstrapCommandText);

    assert.equal(router.toIncomingMessage(createGroupMessageEvent("hello") as any)?.groupId, "20001");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

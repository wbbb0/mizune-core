import type test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createOwnerBootstrap } from "../../src/app/bootstrap/ownerBootstrap.ts";
import { oneBotOwnerBootstrapTransport, officialOwnerBootstrapTransport } from "../../src/app/runtime/ownerBootstrapTransport.ts";
import { UserIdentityStore } from "../../src/identity/userIdentityStore.ts";
import { UserStore } from "../../src/identity/userStore.ts";
import { SetupStateStore } from "../../src/identity/setupStateStore.ts";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { QqOfficialClient } from "../../src/services/qqOfficial/client.ts";
import { DeliveryCoordinator } from "../../src/services/messaging/deliveryCoordinator.ts";
import { characterRepository } from "../../src/character/repository.ts";
import { createTestAppConfig } from "./config-fixtures.tsx";
import type { OneBotClient } from "../../src/services/onebot/onebotClient.ts";

const logger = pino({ level: "silent" });
export async function createOwnerBootstrapFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "owner-bootstrap-"));
  const config = createTestAppConfig({ dataDir: dir, whitelist: { enabled: true } });
  const db = new StateDatabase(dir, logger);
  const identities = new UserIdentityStore(dir, logger, db);
  const users = new UserStore(dir, createTestAppConfig(), logger, db);
  const setup = new SetupStateStore(dir, createTestAppConfig(), identities, logger, db);
  t.after(() => { db.close(); characterRepository(dir).close(); return rm(dir, { recursive: true, force: true }); });
  await identities.init(); await users.init(); await setup.init({ name: "", temperament: "", voiceStyle: "" });
  const service = createOwnerBootstrap({ setupStore: setup, userIdentityStore: identities, userStore: users, buildSetupInstructionText: async () => "请确认基础人格。" });
  const sent: Array<{ userId?: string; text?: string; path?: string }> = [];
  const oneBot = { async getFriendList() { return [{ user_id: 10001 }, { user_id: 10002 }]; }, async sendText(input: { userId: string; text: string }) { sent.push(input); return {}; } } as unknown as OneBotClient;
  const official = new QqOfficialClient({ appId: "app", appSecret: "synthetic" }, logger, { fetch: async (url, init) => {
    if (!url.includes("getAppAccessToken")) sent.push({ path: new URL(url).pathname, text: JSON.parse(String(init.body)).content });
    return { ok: true, status: 200, async json() { return url.includes("getAppAccessToken") ? { access_token: "synthetic-token", expires_in: 7200 } : { id: "sent", timestamp: new Date().toISOString() }; } };
  } });
  const messaging = new DeliveryCoordinator(oneBot, official);
  const permit = official.permits.issue({ chatType: "private", targetId: "opaque_user", messageId: "trigger", timestampMs: Date.now() });
  const transport = officialOwnerBootstrapTransport({ client: official, replyContext: permit, messaging, sessionId: "qq_official.app:p:opaque_user" });
  const request = { channelId: "qq_official.app", requesterUserId: "opaque_user", targetUserId: "opaque_user", chatType: "private" as const };
  return { config, service, setup, identities, users, dir, db, sent, oneBot, official, messaging, permit, transport, request };
}


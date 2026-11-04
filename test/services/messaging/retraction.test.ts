import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { DeliveryCoordinator } from "../../../src/services/messaging/deliveryCoordinator.ts";
import type { OneBotClient } from "../../../src/services/onebot/onebotClient.ts";
import { QqOfficialClient } from "../../../src/services/qqOfficial/client.ts";

test("official retract routes opaque message IDs to the official endpoint", async () => {
  const requests: string[] = [];
  const official = new QqOfficialClient({ appId: "app", appSecret: "test" }, pino({ level: "silent" }), {
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, status: url.includes("getAppAccessToken") ? 200 : 204,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }) };
    }
  });
  const onebot = { deleteMessage: async () => { throw new Error("must not use OneBot"); } } as unknown as OneBotClient;
  const coordinator = new DeliveryCoordinator(onebot, official);
  await coordinator.retract("qq_official.app:g:group", "opaque-message");
  assert.equal(requests.at(-1), "https://api.bot.qq.com/v2/groups/group/messages/opaque-message");
  await assert.rejects(coordinator.retract("qq_official.app:g:group", 123));
});

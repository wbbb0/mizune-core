import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { EventRouter } from "../src/services/onebot/eventRouter.ts";
import { isOwnerBootstrapCommandText } from "../src/app/messaging/directCommands.ts";
import { WhitelistStore } from "../src/identity/whitelistStore.ts";
import { createTestAppConfig } from "./helpers/config-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

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

async function main() {
  await runCase("whitelist store initializes users and groups from data defaults instead of config", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-whitelist-"));
    try {
      const store = new WhitelistStore(dataDir, pino({ level: "silent" }));

      await store.init();

      assert.deepEqual(store.getSnapshot(), { users: [], groups: [] });
      assert.deepEqual(
        JSON.parse(await readFile(join(dataDir, "whitelist.json"), "utf8")),
        { version: 2, users: [], groups: [] }
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("whitelist store migrates legacy owner file into whitelist data", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-whitelist-owner-"));
    try {
      await writeFile(join(dataDir, "owner.json"), `${JSON.stringify({ ownerQq: "10001" }, null, 2)}\n`, "utf8");
      const store = new WhitelistStore(dataDir, pino({ level: "silent" }));

      await store.init();

      assert.deepEqual(store.getSnapshot(), { ownerId: "10001", users: ["10001"], groups: [] });
      assert.deepEqual(
        JSON.parse(await readFile(join(dataDir, "whitelist.json"), "utf8")),
        { version: 2, ownerId: "10001", users: ["10001"], groups: [] }
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("event router allows private .own before owner is bound even when whitelist is enabled", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: true
      }
    });
    const router = new EventRouter(config, {
      hasUser: () => false,
      getOwnerId: () => undefined
    } as any, undefined, isOwnerBootstrapCommandText);

    assert.equal(router.toIncomingMessage(createPrivateMessageEvent(".own") as any)?.text, ".own");
    assert.equal(router.toIncomingMessage(createPrivateMessageEvent("hello") as any), null);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

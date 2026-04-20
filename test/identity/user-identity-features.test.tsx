import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { UserIdentityStore } from "../../src/identity/userIdentityStore.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("identity store binds one external identity to owner", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-user-identities-owner-"));
    try {
      const store = new UserIdentityStore(dataDir, pino({ level: "silent" }));
      await store.init();

      const bound = await store.bindOwnerIdentity({
        channelId: "qqbot",
        externalId: "10001"
      });

      assert.equal(bound.internalUserId, "owner");
      assert.equal(
        await store.findInternalUserId({
          channelId: "qqbot",
          externalId: "10001"
        }),
        "owner"
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(dataDir, "user-identities.json"), "utf8")),
        [
          {
            channelId: "qqbot",
            scope: "private_user",
            externalId: "10001",
            internalUserId: "owner",
            createdAt: bound.createdAt
          }
        ]
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("identity store creates opaque ids for unknown users and reuses existing bindings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-user-identities-generated-"));
    try {
      const store = new UserIdentityStore(dataDir, pino({ level: "silent" }));
      await store.init();

      const first = await store.ensureUserIdentity({
        channelId: "qqbot",
        externalId: "20002"
      });
      const second = await store.ensureUserIdentity({
        channelId: "qqbot",
        externalId: "20002"
      });

      assert.match(first.internalUserId, /^u_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(second.internalUserId, first.internalUserId);
      assert.deepEqual(await store.list(), [first]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("identity store rejects one-to-one binding conflicts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-user-identities-conflict-"));
    try {
      const store = new UserIdentityStore(dataDir, pino({ level: "silent" }));
      await store.init();

      const existing = await store.ensureUserIdentity({
        channelId: "qqbot",
        externalId: "30003"
      });

      await assert.rejects(
        () => store.bindOwnerIdentity({
          channelId: "qqbot",
          externalId: "30003"
        }),
        /already bound/i
      );

      await assert.rejects(
        () => store.bindIdentity({
          channelId: "altbot",
          externalId: "90009",
          internalUserId: existing.internalUserId
        }),
        /already has an external identity/i
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

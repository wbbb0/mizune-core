import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { BrowserProfileStore } from "../../src/services/web/browser/browserProfileStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("browser profile store rejects invalid profile ids without touching sibling paths", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-onebot-browser-profile-store-"));
  const siblingDir = await mkdtemp(join(tmpdir(), "llm-onebot-browser-profile-sibling-"));
  const siblingFile = join(siblingDir, "keep.txt");
  await writeFile(siblingFile, "keep", "utf8");
  try {
    const store = new BrowserProfileStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));

    assert.equal(await store.clearProfile(`../${siblingDir.split("/").at(-1)}`), false);
    await assert.rejects(
      store.saveProfile({
        profileId: "../escape",
        ownerSessionId: "qqbot:p:owner",
        storageState: null,
        sessionStorageByOrigin: {}
      }),
      /invalid browser profile id/
    );
    await stat(siblingFile);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(siblingDir, { recursive: true, force: true });
  }
});

test("browser profile store saves legal profiles and trims complete directories", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-onebot-browser-profile-store-"));
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const config = createTestAppConfig();
    config.browser.playwright.profileMaxCount = 1;
    const store = new BrowserProfileStore(dataDir, config, pino({ level: "silent" }));
    const firstProfileId = "browser_profile_0000000000000001";
    const secondProfileId = "browser_profile_0000000000000002";

    await store.saveProfile({
      profileId: firstProfileId,
      ownerSessionId: "qqbot:p:first",
      storageState: { cookies: [{ name: "first" }] },
      sessionStorageByOrigin: { "https://first.example": { token: "first" } }
    });
    now = 2_000;
    await store.saveProfile({
      profileId: secondProfileId,
      ownerSessionId: "qqbot:p:second",
      storageState: { cookies: [{ name: "second" }] },
      sessionStorageByOrigin: { "https://second.example": { token: "second" } }
    });

    const keptProfile = await store.loadProfile(secondProfileId);
    assert.equal(await store.loadProfile(firstProfileId), null);
    assert.ok(keptProfile);
    assert.deepEqual(keptProfile, {
      profileId: secondProfileId,
      ownerSessionId: "qqbot:p:second",
      createdAtMs: keptProfile.createdAtMs,
      lastUsedAtMs: keptProfile.lastUsedAtMs,
      storageState: { cookies: [{ name: "second" }] },
      sessionStorageByOrigin: { "https://second.example": { token: "second" } }
    });
    assert.deepEqual((await store.listProfiles()).map((item) => item.profile_id), [secondProfileId]);
  } finally {
    Date.now = originalNow;
    await rm(dataDir, { recursive: true, force: true });
  }
});

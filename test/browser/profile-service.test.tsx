import assert from "node:assert/strict";
import { BrowserSessionRuntime } from "../../src/services/web/browser/browserSessionRuntime.ts";
import { BrowserProfileService } from "../../src/services/web/browser/browserProfileService.ts";
import { createForwardFeatureConfig, runCase } from "../helpers/forward-test-support.tsx";

function createSnapshot(profileId: string | null) {
  return {
    profileId,
    requestedUrl: "https://example.com",
    resolvedUrl: "https://example.com",
    title: "Example",
    contentType: "text/html",
    lines: ["Example"],
    links: [],
    elements: [],
    truncated: false
  };
}

async function main() {
  await runCase("browser profile service saves active session state for a live profile", async () => {
    const config = createForwardFeatureConfig();
    config.browser.playwright.enabled = true;
    const sessions = new BrowserSessionRuntime(4);
    const savedProfiles: Array<{ profileId: string; ownerSessionId: string; storageState: unknown }> = [];

    sessions.set("resource_1", {
      backend: {
        name: "playwright",
        async open() {
          throw new Error("not used");
        },
        async interact() {
          throw new Error("not used");
        },
        async captureScreenshot() {
          throw new Error("not used");
        },
        async persistState() {
          return {
            storageState: { cookies: ["a"] },
            sessionStorageByOrigin: {
              "https://example.com": { token: "abc" }
            }
          };
        },
        async close() {}
      } as any,
      state: { id: 1 },
      snapshot: createSnapshot("profile:qqbot:p:10001") as any,
      expiresAt: Date.now() + 1_000,
      ownerSessionId: "qqbot:p:10001",
      profileId: "profile:qqbot:p:10001"
    });

    const service = new BrowserProfileService({
      config,
      sessions,
      profileStore: {
        async ensureProfile() {
          throw new Error("not used");
        },
        async loadProfile() {
          throw new Error("not used");
        },
        async listProfiles() {
          return [];
        },
        async inspectProfile() {
          return null;
        },
        async markUsed() {
          throw new Error("should not markUsed when live session exists");
        },
        async clearProfile() {
          return true;
        },
        async saveProfile(input: { profileId: string; ownerSessionId: string; storageState: unknown }) {
          savedProfiles.push(input);
          return {
            profileId: input.profileId,
            ownerSessionId: input.ownerSessionId,
            createdAtMs: 1,
            lastUsedAtMs: 2,
            storageState: input.storageState,
            sessionStorageByOrigin: {}
          };
        }
      } as any
    });

    const result = await service.saveProfile("profile:qqbot:p:10001");

    assert.equal(result.saved, true);
    assert.deepEqual(savedProfiles, [{
      profileId: "profile:qqbot:p:10001",
      ownerSessionId: "qqbot:p:10001",
      storageState: { cookies: ["a"] },
      sessionStorageByOrigin: {
        "https://example.com": { token: "abc" }
      }
    }]);
  });

  await runCase("browser profile service clears live profile bindings from runtime sessions", async () => {
    const config = createForwardFeatureConfig();
    config.browser.playwright.enabled = true;
    const sessions = new BrowserSessionRuntime(4);
    sessions.set("resource_1", {
      backend: {
        name: "playwright",
        async open() {
          throw new Error("not used");
        },
        async interact() {
          throw new Error("not used");
        },
        async captureScreenshot() {
          throw new Error("not used");
        },
        async persistState() {
          return {
            storageState: null,
            sessionStorageByOrigin: {}
          };
        },
        async close() {}
      } as any,
      state: { id: 1 },
      snapshot: createSnapshot("profile:qqbot:p:10001") as any,
      expiresAt: Date.now() + 1_000,
      ownerSessionId: "qqbot:p:10001",
      profileId: "profile:qqbot:p:10001"
    });

    const service = new BrowserProfileService({
      config,
      sessions,
      profileStore: {
        async ensureProfile() {
          throw new Error("not used");
        },
        async loadProfile() {
          throw new Error("not used");
        },
        async listProfiles() {
          return [];
        },
        async inspectProfile() {
          return null;
        },
        async markUsed() {
          return null;
        },
        async saveProfile() {
          throw new Error("not used");
        },
        async clearProfile() {
          return true;
        }
      } as any
    });

    const result = await service.clearProfile("profile:qqbot:p:10001");

    assert.equal(result.cleared, true);
    assert.equal(sessions.get("resource_1")?.profileId, null);
  });
}

void main();

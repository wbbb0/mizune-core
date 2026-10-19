import test from "node:test";
import assert from "node:assert/strict";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

test("completion endpoint exposes grammar and fresh instance sticker IDs only", async () => {
  const deps = createInternalApiDeps();
  let ids = ["stk_test"];
  let initialized = 0;
  deps.config.stickers.enabled = true;
  deps.config.chatFiles.enabled = true;
  deps.stickerService = {
    init: async () => { initialized++; },
    store: { list: () => ids.map((id) => ({ id, metadata: { description: "not exposed" } })) }
  } as typeof deps.stickerService;
  const app = await createInternalApiApp(deps);
  try {
    const catalog = await app.inject({ method: "GET", url: "/api/command-completions" });
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json().commands.find((item: { name: string }) => item.name === "sticker"), {
      name: "sticker", parameters: [{ name: "操作", values: ["lock", "unlock"] }, { name: "表情ID", source: "stickerIds" }]
    });
    const getIds = async () => (await app.inject({ method: "GET", url: "/api/command-completions/sticker-ids" })).json();
    assert.deepEqual(await getIds(), { values: ["stk_test"] });
    ids = ["stk_new"];
    assert.deepEqual(await getIds(), { values: ["stk_new"] });
    deps.config.stickers.enabled = false;
    assert.deepEqual(await getIds(), { values: [] });
    assert.equal(initialized, 2);
  } finally { await app.close(); }
});

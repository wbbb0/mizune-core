import test from "node:test";
import assert from "node:assert/strict";
import { stickerToolDescriptors, stickerToolHandlers } from "../../src/llm/tools/runtime/stickerTools.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("native QQ collections require the current NapCat session source even when invoked directly", async () => {
  const config = createTestAppConfig();
  config.onebot.enabled = true;
  config.onebot.provider = "napcat";
  let reads = 0;
  const context = { config, stickerService: { async init() {} }, lastMessage: { sessionId: "web:test" },
    oneBotClient: { async fetchCustomFaces() { reads++; return []; } }
  } as any;
  for (const sessionId of ["web:test", "qq_official.app:p:user", "other:p:user", "invalid"]) {
    context.lastMessage.sessionId = sessionId;
    assert.match(String(await stickerToolHandlers.sticker_qq_list!({} as any, {}, context)), /仅限/);
    assert.match(String(await stickerToolHandlers.sticker_collect!({} as any, { qq_url: "https://example.com/x", reason: "测试" }, context)), /仅限/);
  }
  assert.equal(reads, 0);
  context.lastMessage.sessionId = `${config.configRuntime.instanceName}:g:group`;
  assert.equal(JSON.parse(String(await stickerToolHandlers.sticker_qq_list!({} as any, {}, context))).returned, 0);
  assert.equal(reads, 1);
  config.onebot.enabled = false;
  assert.match(String(await stickerToolHandlers.sticker_qq_list!({} as any, {}, context)), /仅限/);
  assert.equal(reads, 1);
  const descriptor = stickerToolDescriptors.find(tool => tool.definition.function.name === "sticker_qq_list")!;
  assert.equal(descriptor.isVisible!({ sessionId: "qq_official.app:p:user" }), false);
  assert.equal(descriptor.isVisible!({ sessionId: "web:test" }), false);
});

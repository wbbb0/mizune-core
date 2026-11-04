import test from "node:test";
import assert from "node:assert/strict";
import { createBuiltinToolExecutor, getBuiltinTools } from "../../src/llm/tools/index.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createFunctionToolCall } from "../helpers/tool-test-support.tsx";
import { resolveConnectorCapabilities } from "../../src/services/messaging/connectorCapabilities.ts";

function fixture() {
  const config = createTestAppConfig({ appName: "qqbot", onebot: { enabled: true, provider: "napcat" }, qqOfficial: { enabled: true, appId: "test-app" } });
  config.configRuntime.instanceName = "qqbot";
  return config;
}

test("运行时目录只承认会话来源，输出方式不能授予账号管理权限", () => {
  const config = fixture();
  for (const sessionId of [undefined, "", "invalid", "web:independent", "other:p:123", "qq_official.test-app:p:123", "qq_official.test-app:g:456"]) {
    for (const replyDelivery of ["onebot", "web", "qq_official"] as const) {
      const tools = getBuiltinTools("owner", null, config, { visibilityContext: { sessionId, replyDelivery } });
      assert.ok(tools.every(tool => !tool.function.name.startsWith("self_account_")), `${sessionId}/${replyDelivery}`);
    }
  }
  for (const sessionId of ["qqbot:p:123", "qqbot:g:456"]) {
    const tools = getBuiltinTools("owner", null, config, { visibilityContext: { sessionId, replyDelivery: "web" } });
    assert.ok(tools.some(tool => tool.function.name === "self_account_view"));
  }
});

test("执行入口拒绝伪造 visibilityContext，且不调用底层账号接口", async () => {
  let calls = 0;
  const context = {
    config: fixture(), relationship: "owner", currentUser: null, replyDelivery: "web",
    lastMessage: { sessionId: "web:independent", userId: "owner", senderName: "测试" },
    sessionManager: { getOperationMode: () => ({ kind: "normal" }), getSession: () => null },
    oneBotClient: { async getLoginInfo() { calls++; throw new Error("不应调用"); } }
  } as unknown as BuiltinToolContext;
  const execute = createBuiltinToolExecutor(context, { availableToolNames: ["self_account_view"], visibilityContext: { sessionId: "qqbot:p:123", replyDelivery: "onebot" } });
  const result = await execute(createFunctionToolCall("self_account_view"), {});
  assert.match(typeof result === "string" ? result : result.content, /error/);
  assert.equal(calls, 0);
});

test("本轮展示之后关闭连接器或撤销 owner，执行时收紧快照", async () => {
  for (const change of ["connector", "owner"] as const) {
    let calls = 0;
    const context = {
      config: fixture(), relationship: "owner", currentUser: null, replyDelivery: "onebot",
      lastMessage: { sessionId: "qqbot:p:123", userId: "owner", senderName: "测试" },
      sessionManager: { getOperationMode: () => ({ kind: "normal" }), getSession: () => null },
      oneBotClient: { async getLoginInfo() { calls++; throw new Error("不应调用"); } }
    } as unknown as BuiltinToolContext;
    const execute = createBuiltinToolExecutor(context, { availableToolNames: ["self_account_view"] });
    if (change === "connector") context.config.onebot.enabled = false;
    else context.relationship = "known";
    const result = await execute(createFunctionToolCall("self_account_view"), {});
    assert.match(typeof result === "string" ? result : result.content, /error/);
    assert.equal(calls, 0, change);
  }
});

test("本轮缺失能力后来启用不能扩展已展示工具快照", async () => {
  const config = fixture(); config.onebot.enabled = false;
  const context = {
    config, relationship: "owner", currentUser: null, replyDelivery: "onebot",
    lastMessage: { sessionId: "qqbot:p:123", userId: "owner", senderName: "测试" },
    sessionManager: { getOperationMode: () => ({ kind: "normal" }), getSession: () => null }
  } as unknown as BuiltinToolContext;
  const execute = createBuiltinToolExecutor(context, { availableToolNames: ["self_account_view"] });
  config.onebot.enabled = true;
  const result = await execute(createFunctionToolCall("self_account_view"), {});
  assert.match(typeof result === "string" ? result : result.content, /error/);
});

test("媒体能力按连接器区分，普通 OneBot 保留图片和音频但不承诺普通文件", () => {
  const config = fixture();
  config.onebot.provider = "generic";
  const generic = resolveConnectorCapabilities(config, { sessionId: "qqbot:p:123", replyDelivery: "onebot" });
  assert.ok(generic.has("media.image.send"));
  assert.ok(generic.has("media.audio.send"));
  assert.equal(generic.has("media.file.send"), false);
  for (const sessionId of ["web:independent", "qq_official.test-app:p:123", "qq_official.test-app:g:456"]) {
    assert.ok(resolveConnectorCapabilities(config, { sessionId }).has("media.file.send"), sessionId);
  }
  config.onebot.provider = "napcat";
  assert.ok(resolveConnectorCapabilities(config, { sessionId: "qqbot:p:123" }).has("media.file.send"));
  config.onebot.enabled = false;
  assert.equal(resolveConnectorCapabilities(config, { sessionId: "qqbot:p:123" }).size, 0);
});

test("收藏分支按真实来源投影 schema，手写隐藏 qq_url 在执行入口被拒绝", async () => {
  const config = fixture(); config.stickers.enabled = true;
  for (const sessionId of ["web:independent", "qq_official.test-app:p:123"]) {
    const tools = getBuiltinTools("owner", null, config, { visibilityContext: { sessionId, replyDelivery: "web" } });
    const collect = tools.find(tool => tool.function.name === "sticker_collect");
    assert.ok(collect);
    assert.ok("asset_id" in (collect.function.parameters as { properties: Record<string, unknown> }).properties);
    assert.equal("qq_url" in (collect.function.parameters as { properties: Record<string, unknown> }).properties, false);
    assert.doesNotMatch(collect.function.description, /qq_url|sticker_qq_list|NapCat/);
    let calls = 0;
    const context = {
      config, relationship: "owner", currentUser: null, replyDelivery: "web",
      lastMessage: { sessionId, userId: "owner", senderName: "测试" },
      sessionManager: { getOperationMode: () => ({ kind: "normal" }), getSession: () => null },
      stickerService: { async init() { calls++; throw new Error("不应调用"); } }
    } as unknown as BuiltinToolContext;
    const execute = createBuiltinToolExecutor(context, { availableToolNames: ["sticker_collect"] });
    const result = await execute(createFunctionToolCall("sticker_collect"), { qq_url: "https://example.test/image.png", reason: "测试" });
    assert.match(typeof result === "string" ? result : result.content, /error/);
    assert.equal(calls, 0);
  }
  const native = getBuiltinTools("owner", null, config, { visibilityContext: { sessionId: "qqbot:p:123" } }).find(tool => tool.function.name === "sticker_collect");
  assert.ok(native && "qq_url" in (native.function.parameters as { properties: Record<string, unknown> }).properties);
});

test("缺少原生历史接口的官方和 Web 会话仍保留缓存转发读取工具", () => {
  const config = fixture();
  for (const sessionId of ["web:independent", "qq_official.test-app:p:123", "qq_official.test-app:g:456"]) {
    assert.ok(getBuiltinTools("owner", null, config, { visibilityContext: { sessionId } }).some(tool => tool.function.name === "view_forward_record"), sessionId);
  }
});

test("跨会话发送同时校验真实目标连接，不开启官方主动发送或借用其他连接", async () => {
  for (const target of ["qq_official.test-app:p:123", "qq_official.test-app:g:456", "other:p:123", "web:independent"]) {
    const context = {
      config: fixture(), relationship: "owner", currentUser: null, replyDelivery: "onebot",
      lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "测试" },
      sessionManager: { getOperationMode: () => ({ kind: "normal" }), getSession: () => null }
    } as unknown as BuiltinToolContext;
    const execute = createBuiltinToolExecutor(context, { availableToolNames: ["delegate_message_to_chat"] });
    const result = await execute(createFunctionToolCall("delegate_message_to_chat"), { sessionId: target, instruction: "测试" });
    assert.match(typeof result === "string" ? result : result.content, /目标会话连接不支持/);
  }
});

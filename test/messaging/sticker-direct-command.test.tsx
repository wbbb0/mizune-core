import test from "node:test";
import assert from "node:assert/strict";
import { parseDirectCommand, resolveDispatchableDirectCommand } from "../../src/app/messaging/directCommands.ts";
import { stickerToolDescriptors, stickerToolHandlers } from "../../src/llm/tools/runtime/stickerTools.ts";
import { createDirectCommandFixture } from "../helpers/direct-command-fixtures.tsx";

test("表情锁只通过用户命令管理，不向模型注册工具", () => {
  assert.equal(stickerToolHandlers.sticker_set_lock, undefined);
  assert.equal(stickerToolDescriptors.some((tool) => tool.definition.function.name === "sticker_set_lock"), false);
  assert.deepEqual(parseDirectCommand("。sticker lock sticker_1"), { name: "sticker", action: "lock", id: "sticker_1" });
  assert.equal(resolveDispatchableDirectCommand({ phase: "chat", setupState: "ready", chatType: "private", text: ".sticker lock" })?.name, "invalid");
  assert.equal(resolveDispatchableDirectCommand({ phase: "chat", setupState: "ready", chatType: "group", relationship: "known", isAtMentioned: true, text: ".sticker unlock sticker_1" }), null);
});

test("owner 直接锁定解锁使用当前版本，非 owner 不能访问存储", async () => {
  const changes: unknown[] = [];
  let reads = 0;
  const fixture = createDirectCommandFixture({ stickerService: {
    async init() {},
    store: {
      get(id: string) { reads++; return { id, revision: 7 }; },
      setLocked(...args: unknown[]) { changes.push(args); }
    } as any
  } });
  for (const action of ["lock", "unlock"] as const) {
    await fixture.handler({ command: { name: "sticker", action, id: "sticker_1" }, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
  }
  assert.deepEqual(changes, [["sticker_1", 7, true], ["sticker_1", 7, false]]);
  assert.equal(fixture.calls[0]?.recordInHistory, false);
  assert.match(fixture.calls[1]!.text, /已解锁/);
  await fixture.handler({ command: { name: "sticker", action: "unlock", id: "sticker_1" }, sessionId: "qqbot:p:guest", incomingMessage: { chatType: "private", userId: "guest", relationship: "known" } });
  assert.equal(reads, 2);
  assert.match(fixture.calls[2]!.text, /只有 owner/);
});

test("表情锁命令报告停用或不存在，不抛出消息链路异常", async () => {
  for (const enabled of [false, true]) {
    const fixture = createDirectCommandFixture({ config: { stickers: { enabled, maxCount: 25 } }, stickerService: {
      async init() {},
      store: { get() { throw new Error("表情不存在"); } } as any
    } });
    await fixture.handler({ command: { name: "sticker", action: "lock", id: "missing" }, sessionId: "qqbot:p:owner", incomingMessage: { chatType: "private", userId: "owner", relationship: "owner" } });
    assert.match(fixture.calls[0]!.text, enabled ? /表情不存在/ : /未启用/);
  }
});

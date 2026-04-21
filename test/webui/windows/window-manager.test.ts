import type { WindowDefinition } from "../../../webui/src/components/workbench/windows/types.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowManager } from "../../../webui/src/composables/workbench/windowManager.ts";

function buildWindow(id: string, parentId?: string): WindowDefinition {
  return {
    id,
    kind: parentId ? "child-dialog" : "dialog",
    title: id,
    size: "md" as const,
    ...(parentId ? { parentId } : {})
  };
}

test("window manager keeps child windows above ancestors after focusing the parent", () => {
  const manager = createWindowManager();

  manager.openSync(buildWindow("parent"));
  manager.openSync(buildWindow("child", "parent"));

  manager.focus("parent");

  assert.deepEqual(manager.snapshot().map((window) => window.id), ["parent", "child"]);
});

test("window manager keeps child windows above ancestors after moving the parent on desktop", () => {
  const manager = createWindowManager();

  manager.openSync(buildWindow("parent"));
  manager.openSync(buildWindow("child", "parent"));

  manager.move("parent", { x: 120, y: 240 });

  assert.deepEqual(manager.snapshot().map((window) => window.id), ["parent", "child"]);
  assert.deepEqual(manager.get("parent")?.position, { x: 120, y: 240 });
});

test("window manager exposes only the top window on mobile", () => {
  const manager = createWindowManager();

  manager.openSync(buildWindow("parent"));
  manager.openSync(buildWindow("child", "parent"));

  assert.deepEqual(manager.visibleStack("mobile").map((window) => window.id), ["child"]);
});

test("window manager resolves open() with the payload passed to close()", async () => {
  const manager = createWindowManager();
  const opening = manager.open({
    id: "dialog",
    kind: "dialog",
    title: "dialog",
    size: "sm"
  });

  const payload = {
    reason: "action" as const,
    actionId: "save",
    values: { title: "saved" },
    result: { ok: true }
  };

  manager.close("dialog", payload);

  await assert.doesNotReject(opening);
  await assert.deepEqual(await opening, payload);
});

test("window manager closes descendant windows when closing a parent window", async () => {
  const manager = createWindowManager();

  const parent = manager.open({
    id: "parent",
    kind: "dialog",
    title: "parent",
    size: "md"
  });
  const child = manager.open({
    id: "child",
    kind: "child-dialog",
    title: "child",
    size: "sm",
    parentId: "parent"
  });

  manager.close("parent", {
    reason: "close",
    values: { parent: true }
  });

  await assert.deepEqual(await parent, {
    reason: "close",
    values: { parent: true }
  });
  await assert.deepEqual(await child, {
    reason: "dismiss",
    values: {}
  });
  assert.deepEqual(manager.snapshot(), []);
});

test("window manager isolates internal definition state from caller mutation and snapshot mutation", () => {
  const manager = createWindowManager();
  const definition = {
    id: "config",
    kind: "dialog" as const,
    title: "Config",
    size: "md" as const,
    blocks: [{ kind: "text" as const, content: "original" }]
  };

  const opened = manager.openSync(definition);
  definition.title = "mutated";
  const originalBlock = definition.blocks[0];
  assert.ok(originalBlock);
  if (originalBlock.kind === "text") {
    originalBlock.content = "changed";
  }

  assert.strictEqual(manager.get("config")?.definition.title, "Config");
  const storedBlock = manager.get("config")?.definition.blocks?.[0];
  assert.ok(storedBlock);
  if (storedBlock.kind === "text") {
    assert.strictEqual(storedBlock.content, "original");
  }
  assert.strictEqual(opened.definition.title, "Config");

  const snapshot = manager.snapshot();
  assert.ok(snapshot[0]);
  snapshot[0]!.definition.title = "polluted";
  const snapshotBlock = snapshot[0]!.definition.blocks?.[0];
  if (snapshotBlock && snapshotBlock.kind === "text") {
    snapshotBlock.content = "polluted";
  }

  assert.strictEqual(manager.get("config")?.definition.title, "Config");
  const finalBlock = manager.get("config")?.definition.blocks?.[0];
  assert.ok(finalBlock);
  if (finalBlock.kind === "text") {
    assert.strictEqual(finalBlock.content, "original");
  }
});

test("window manager keeps focus below descendants even with unrelated windows mixed in", () => {
  const manager = createWindowManager();

  manager.openSync(buildWindow("parent"));
  manager.openSync(buildWindow("sibling"));
  manager.openSync(buildWindow("child", "parent"));

  manager.focus("parent");

  assert.deepEqual(manager.snapshot().map((window) => window.id), ["sibling", "parent", "child"]);
});

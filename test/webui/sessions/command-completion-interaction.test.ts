import test from "node:test";
import assert from "node:assert/strict";
import { computed, effectScope, nextTick, ref } from "vue";
import { getDirectCommandCompletions } from "../../../src/app/messaging/directCommands.ts";
import { useCommandCompletion } from "../../../webui/src/components/sessions/useCommandCompletion.ts";

function key(key: string, extra: Partial<KeyboardEvent> = {}) {
  return { key, preventDefault() {}, ...extra } as KeyboardEvent;
}

test("keyboard completion respects IME, dismissal, selection and complete command sending", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ commands: getDirectCommandCompletions() }));
  const scope = effectScope();
  try {
    const draft = ref(".deb");
    const field = { selectionStart: 4, selectionEnd: 4, focus() {}, setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } } as HTMLTextAreaElement;
    const controller = scope.run(() => useCommandCompletion(computed({ get: () => draft.value, set: (v) => { draft.value = v; } }), ref(field)))!;
    await controller.focus();
    assert.deepEqual(controller.values.value, ["debug"]);
    assert.equal(controller.keydown(key("Enter", { isComposing: true })), true);
    assert.equal(draft.value, ".deb");
    assert.equal(controller.keydown(key("Enter", { keyCode: 229 })), true);
    assert.equal(controller.keydown(key("Enter", { shiftKey: true })), false);
    assert.equal(controller.keydown(key("Tab")), true);
    await nextTick();
    assert.equal(draft.value, ".debug ");
    assert.deepEqual(controller.values.value, ["on", "off", "once", "status"]);
    controller.keydown(key("ArrowDown"));
    controller.keydown(key("Enter"));
    await nextTick();
    assert.equal(draft.value, ".debug off ");
    assert.equal(controller.keydown(key("Enter")), false);
    draft.value = ".deb";
    field.selectionStart = field.selectionEnd = 4;
    await nextTick();
    controller.syncCaret();
    assert.equal(controller.keydown(key("Escape")), true);
    assert.deepEqual(controller.values.value, []);
    await controller.focus();
    field.selectionStart = 1;
    controller.syncCaret();
    assert.deepEqual(controller.values.value, []);
    controller.blur();
    assert.deepEqual(controller.values.value, []);
  } finally { scope.stop(); globalThis.fetch = previousFetch; }
});

test("dynamic IDs reload on reentry, ignore stale results, and failures leave text usable", async () => {
  const previousFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = async (url) => String(url).endsWith("sticker-ids")
    ? new Promise<Response>((resolve) => pending.push(resolve))
    : new Response(JSON.stringify({ commands: getDirectCommandCompletions() }));
  const scope = effectScope();
  try {
    const draft = ref(".sticker lock ");
    const field = { selectionStart: draft.value.length, selectionEnd: draft.value.length } as HTMLTextAreaElement;
    const controller = scope.run(() => useCommandCompletion(computed({ get: () => draft.value, set: (v) => { draft.value = v; } }), ref(field)))!;
    await controller.focus();
    await nextTick();
    assert.equal(pending.length, 1);
    controller.blur();
    await nextTick();
    await controller.focus();
    await nextTick();
    assert.equal(pending.length, 2);
    pending[1]!(new Response(JSON.stringify({ values: ["stk_new"] })));
    await new Promise((resolve) => setImmediate(resolve));
    pending[0]!(new Response(JSON.stringify({ values: ["stk_stale"] })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(controller.values.value, ["stk_new"]);
    controller.blur();
    await nextTick();
    await controller.focus();
    await nextTick();
    pending[2]!(new Response("unavailable", { status: 503 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.loadError.value, true);
    assert.deepEqual(controller.values.value, []);
    assert.equal(controller.keydown(key("Enter")), false);
    assert.equal(draft.value, ".sticker lock ");
  } finally { scope.stop(); globalThis.fetch = previousFetch; }
});

test("skill ID completion uses its own endpoint, rejects stale responses, and remains usable after failure", async () => {
  const previousFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  const paths: string[] = [];
  globalThis.fetch = async (url) => {
    paths.push(String(url));
    return String(url).endsWith("skill-ids")
      ? new Promise<Response>((resolve) => pending.push(resolve))
      : new Response(JSON.stringify({ commands: [{ name: "config", parameters: [{ name: "目标", values: ["skill"] }, { name: "技能", source: "skillIds", when: { index: 0, value: "skill" } }] }] }));
  };
  const scope = effectScope();
  try {
    const draft = ref(".config skill ");
    const field = { selectionStart: draft.value.length, selectionEnd: draft.value.length } as HTMLTextAreaElement;
    const controller = scope.run(() => useCommandCompletion(computed({ get: () => draft.value, set: (value) => { draft.value = value; } }), ref(field)))!;
    await controller.focus(); await nextTick();
    controller.blur(); await nextTick();
    await controller.focus(); await nextTick();
    pending[1]!(new Response(JSON.stringify({ values: ["current"] })));
    await new Promise((resolve) => setImmediate(resolve));
    pending[0]!(new Response(JSON.stringify({ values: ["outdated"] })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(controller.values.value, ["current"]);
    assert.equal(paths.filter((path) => path === "/api/command-completions/skill-ids").length, 2);
    controller.blur(); await nextTick(); await controller.focus(); await nextTick();
    pending[2]!(new Response("unavailable", { status: 503 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.loadError.value, true);
    assert.equal(controller.keydown(key("Enter")), false);
    assert.equal(draft.value, ".config skill ");
  } finally { scope.stop(); globalThis.fetch = previousFetch; }
});

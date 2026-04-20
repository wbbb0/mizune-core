import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionListItem, syncSessionDisplayFields } from "../../webui/src/stores/sessionDisplay.ts";

  test("web session uses title as display label", () => {
    assert.equal(normalizeSessionListItem({
      id: "web:1",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "owner" },
      title: "Warehouse infiltration",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 0
    }).displayLabel, "Warehouse infiltration");
  });

  test("onebot session keeps participant label even when title exists", () => {
    assert.equal(normalizeSessionListItem({
      id: "qqbot:p:10001",
      type: "private",
      source: "onebot",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "10001" },
      title: "Alice",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 0
    }).displayLabel, "10001");
  });

  test("group session keeps group entry label even when title exists", () => {
    assert.equal(normalizeSessionListItem({
      id: "qqbot:g:20001",
      type: "group",
      source: "onebot",
      modeId: "rp_assistant",
      participantRef: { kind: "group", id: "20001" },
      title: "Group title",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 0
    }).displayLabel, "群 20001");
  });

  test("selected active session syncs refreshed title and display label", () => {
    const current = {
      id: "web:1",
      type: "private" as const,
      source: "web" as const,
      modeId: "rp_assistant",
      participantRef: { kind: "user" as const, id: "owner" },
      title: "Old title",
      titleSource: "manual" as const,
      displayLabel: "Old title",
      lastActiveAt: 10
    };
    const refreshed = normalizeSessionListItem({
      id: "web:1",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "owner" },
      title: "New title",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 20
    });

    assert.deepEqual(syncSessionDisplayFields(current, refreshed), {
      ...current,
      title: "New title",
      titleSource: "manual",
      displayLabel: "New title",
      lastActiveAt: 20
    });
  });

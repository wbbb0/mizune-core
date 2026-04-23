import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSessionListItem,
  sortSessionListItems,
  syncSessionDisplayFields
} from "../../webui/src/stores/sessionDisplay.ts";

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

  test("session list items sort by lastActiveAt desc then id", () => {
    const older = normalizeSessionListItem({
      id: "web:b",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "owner" },
      title: "Older",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 10
    });
    const newer = normalizeSessionListItem({
      id: "web:a",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "owner" },
      title: "Newer",
      titleSource: "auto",
      isGenerating: false,
      lastActiveAt: 30
    });

    assert.deepEqual([older, newer].sort(sortSessionListItems).map((item) => item.id), ["web:a", "web:b"]);
  });

  test("selected active session syncs auto generated title from list upsert", () => {
    const current = {
      id: "web:1",
      type: "private" as const,
      source: "web" as const,
      modeId: "rp_assistant",
      participantRef: { kind: "user" as const, id: "owner" },
      title: "New Chat",
      titleSource: "default" as const,
      displayLabel: "New Chat",
      lastActiveAt: 10
    };
    const refreshed = normalizeSessionListItem({
      id: "web:1",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "owner" },
      title: "仓库排查",
      titleSource: "auto",
      isGenerating: false,
      lastActiveAt: 30
    });

    assert.deepEqual(syncSessionDisplayFields(current, refreshed), {
      ...current,
      title: "仓库排查",
      titleSource: "auto",
      displayLabel: "仓库排查",
      lastActiveAt: 30
    });
  });

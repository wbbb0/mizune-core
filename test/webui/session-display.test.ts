import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSessionListItem,
  sortSessionListItems,
  syncSessionDisplayFields
} from "../../webui/src/stores/sessionDisplay.ts";

test("session list item display label follows source and participant rules", () => {
  const cases = [
    {
      name: "web session title",
      input: {
        id: "web:1",
        type: "private" as const,
        source: "web" as const,
        participantRef: { kind: "user" as const, id: "owner" },
        title: "Warehouse infiltration"
      },
      expected: "Warehouse infiltration"
    },
    {
      name: "onebot private participant",
      input: {
        id: "qqbot:p:10001",
        type: "private" as const,
        source: "onebot" as const,
        participantRef: { kind: "user" as const, id: "10001" },
        title: "Alice"
      },
      expected: "10001"
    },
    {
      name: "onebot group participant",
      input: {
        id: "qqbot:g:20001",
        type: "group" as const,
        source: "onebot" as const,
        participantRef: { kind: "group" as const, id: "20001" },
        title: "Group title"
      },
      expected: "群 20001"
    }
  ];

  for (const item of cases) {
    assert.equal(normalizeSessionListItem({
      ...item.input,
      modeId: "rp_assistant",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 0
    }).displayLabel, item.expected, item.name);
  }
});

test("selected active session syncs refreshed manual and auto titles from list upserts", () => {
  const cases = [
    {
      name: "manual title",
      currentTitle: "Old title",
      currentTitleSource: "manual" as const,
      refreshedTitle: "New title",
      refreshedTitleSource: "manual" as const,
      lastActiveAt: 20
    },
    {
      name: "auto title",
      currentTitle: "New Chat",
      currentTitleSource: "default" as const,
      refreshedTitle: "仓库排查",
      refreshedTitleSource: "auto" as const,
      lastActiveAt: 30
    }
  ];

  for (const item of cases) {
    const current = {
      id: "web:1",
      type: "private" as const,
      source: "web" as const,
      modeId: "rp_assistant",
      participantRef: { kind: "user" as const, id: "owner" },
      title: item.currentTitle,
      titleSource: item.currentTitleSource,
      displayLabel: item.currentTitle,
      lastActiveAt: 10
    };
    const refreshed = normalizeSessionListItem({
      id: "web:1",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantRef: { kind: "user", id: "owner" },
      title: item.refreshedTitle,
      titleSource: item.refreshedTitleSource,
      isGenerating: false,
      lastActiveAt: item.lastActiveAt
    });

    assert.deepEqual(syncSessionDisplayFields(current, refreshed), {
      ...current,
      title: item.refreshedTitle,
      titleSource: item.refreshedTitleSource,
      displayLabel: item.refreshedTitle,
      lastActiveAt: item.lastActiveAt
    }, item.name);
  }
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

import assert from "node:assert/strict";
import { normalizeSessionListItem, syncSessionDisplayFields } from "../../webui/src/stores/sessionDisplay.ts";

async function runCase(name: string, fn: () => void | Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("web session uses title as display label", () => {
    assert.equal(normalizeSessionListItem({
      id: "web:1",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantUserId: "owner",
      participantRef: { kind: "user", id: "owner" },
      title: "Warehouse infiltration",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 0
    }).participantLabel, "Warehouse infiltration");
  });

  await runCase("onebot session keeps participant label even when title exists", () => {
    assert.equal(normalizeSessionListItem({
      id: "qqbot:p:10001",
      type: "private",
      source: "onebot",
      modeId: "rp_assistant",
      participantUserId: "10001",
      participantRef: { kind: "user", id: "10001" },
      title: "Alice",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 0
    }).participantLabel, "10001");
  });

  await runCase("group session keeps group entry label even when title exists", () => {
    assert.equal(normalizeSessionListItem({
      id: "qqbot:g:20001",
      type: "group",
      source: "onebot",
      modeId: "rp_assistant",
      participantUserId: "20001",
      participantRef: { kind: "group", id: "20001" },
      title: "Group title",
      titleSource: "manual",
      isGenerating: false,
      lastActiveAt: 0
    }).participantLabel, "群 20001");
  });

  await runCase("selected active session syncs refreshed title and display label", () => {
    const current = {
      id: "web:1",
      type: "private" as const,
      source: "web" as const,
      modeId: "rp_assistant",
      participantUserId: "owner",
      participantRef: { kind: "user" as const, id: "owner" },
      title: "Old title",
      titleSource: "manual" as const,
      participantLabel: "Old title",
      lastActiveAt: 10
    };
    const refreshed = normalizeSessionListItem({
      id: "web:1",
      type: "private",
      source: "web",
      modeId: "rp_assistant",
      participantUserId: "owner",
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
      participantLabel: "New title",
      lastActiveAt: 20
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import type {
  ScenarioHostHeldItem,
  ScenarioHostNpc,
  ScenarioHostSessionState,
  ScenarioHostWornItem
} from "./types.ts";

export function formatScenarioHostRuntimeDraftLines(state: ScenarioHostSessionState): string[] {
  return [
    "运行态：",
    `当前局势：${formatDraftValue(state.currentSituation)}`,
    `当前位置：${formatDraftValue(state.currentLocation ?? "")}`,
    `玩家角色：${formatPlayerDraft(state)}`,
    `NPC：${formatNpcList(state.npcs)}`,
    `目标：${state.objectives.length > 0 ? state.objectives.map((item) => `${item.title}(${item.status})`).join("；") : "（未填写）"}`,
    `Lore：${state.loreEntries.length > 0 ? state.loreEntries.map((item) => item.title).join("；") : "（未填写）"}`,
    `非角色实体：${state.entities.length > 0 ? state.entities.map((item) => `${item.name}(${item.kind})`).join("；") : "（未填写）"}`,
    `关系：${state.relations.length > 0 ? state.relations.map((item) => `${item.sourceId}-${item.kind}->${item.targetId}`).join("；") : "（未填写）"}`,
    `剧情日志：${state.journal.length > 0 ? state.journal.map((item) => item.title).join("；") : "（未填写）"}`
  ];
}

function formatPlayerDraft(state: ScenarioHostSessionState): string {
  const player = state.player;
  return [
    player.displayName,
    player.basicInfo ? `基础=${player.basicInfo}` : null,
    player.characterDescription ? `描述=${player.characterDescription}` : null,
    `穿着=${formatWornItems(player.wornItems)}`,
    `持有=${formatHeldItems(player.heldItems)}`,
    player.statusDescription ? `临时状态=${player.statusDescription}` : null
  ].filter((item): item is string => Boolean(item)).join("；");
}

function formatNpcList(npcs: ScenarioHostNpc[]): string {
  if (npcs.length === 0) {
    return "（未填写）";
  }
  return npcs.map((npc) => [
    `${npc.name}[${npc.id}]`,
    `基础=${npc.basicInfo}`,
    `描述=${npc.characterDescription}`,
    `穿着=${formatWornItems(npc.wornItems)}`,
    `持有=${formatHeldItems(npc.heldItems)}`,
    npc.statusDescription ? `临时状态=${npc.statusDescription}` : null
  ].filter((item): item is string => Boolean(item)).join("；")).join("\n- ");
}

function formatWornItems(items: ScenarioHostWornItem[]): string {
  return items.length > 0
    ? items.map((item) => `${item.wearPosition}:${item.name}(${item.description})`).join("、")
    : "（未填写）";
}

function formatHeldItems(items: ScenarioHostHeldItem[]): string {
  return items.length > 0
    ? items.map((item) => `${item.name}x${item.quantity}(${item.description})`).join("、")
    : "（未填写）";
}

function formatDraftValue(value: string): string {
  const trimmed = value.trim();
  return trimmed || "（未填写）";
}

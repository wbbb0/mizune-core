import { contextTermOverlapScore } from "#context/contextTextTerms.ts";
import type {
  ScenarioHostEntity,
  ScenarioHostHeldItem,
  ScenarioHostJournalEntry,
  ScenarioHostLoreEntry,
  ScenarioHostNpc,
  ScenarioHostRelation,
  ScenarioHostSessionState,
  ScenarioHostWornItem
} from "./types.ts";

const SCENARIO_ACTIVE_LORE_LIMIT = 8;
const SCENARIO_LORE_BASELINE_LIMIT = 3;
const SCENARIO_RELEVANT_NPC_LIMIT = 8;
const SCENARIO_RELEVANT_ENTITY_LIMIT = 8;
const SCENARIO_RELEVANT_RELATION_LIMIT = 8;
const SCENARIO_RELEVANT_JOURNAL_LIMIT = 6;
const SCENARIO_RELATION_ENDPOINT_LIMIT = 4;

interface RankedScenarioItem<T> {
  item: T;
  score: number;
  priority: number;
  recency: number;
  label: string;
}

export function buildScenarioRuntimeQueryText(input: {
  state: ScenarioHostSessionState;
  queryText: string;
  historyForPrompt: Array<{ content: string }>;
}): string {
  return [
    input.state.currentSituation,
    input.state.currentLocation ?? "",
    input.state.sceneSummary,
    input.state.player.basicInfo,
    input.state.player.characterDescription,
    input.state.player.statusDescription,
    input.historyForPrompt.slice(-8).map((message) => message.content).join("\n"),
    input.queryText
  ].filter((part) => part.trim().length > 0).join("\n").trim();
}

export function buildScenarioStateLines(state: ScenarioHostSessionState, options?: {
  queryText?: string;
}): string[] {
  const queryText = options?.queryText ?? "";
  const activeLoreEntries = selectScenarioLoreEntries(state, queryText);
  const directlyRelevantNpcs = selectScenarioNpcs(state, queryText);
  const directlyRelevantEntities = selectScenarioEntities(state, queryText);
  const directlyRelevantSubjectIds = new Set([
    state.player.userId,
    ...directlyRelevantNpcs.map((item) => item.id),
    ...directlyRelevantEntities.map((item) => item.id)
  ]);
  const relevantRelations = selectScenarioRelations(state, queryText, directlyRelevantSubjectIds);
  const relevantNpcs = includeScenarioRelationEndpointNpcs(state, directlyRelevantNpcs, relevantRelations);
  const relevantEntities = includeScenarioRelationEndpointEntities(state, directlyRelevantEntities, relevantRelations);
  const relevantSubjectIds = new Set([
    state.player.userId,
    ...relevantNpcs.map((item) => item.id),
    ...relevantEntities.map((item) => item.id)
  ]);
  const relevantJournal = selectScenarioJournalEntries(state, queryText, relevantSubjectIds);

  return [
    `当前局势=${state.currentSituation}`,
    `当前位置=${state.currentLocation ?? "未设定"}`,
    `场景摘要=${state.sceneSummary || "无"}`,
    `主玩家=${formatScenarioPlayer(state.player)}`,
    `目标=${state.objectives.length > 0 ? state.objectives.map((item) => `${item.id}:${item.title}[${item.status}] ${item.summary}`.trim()).join("；") : "无"}`,
    "上下文选择=当前回合仅注入激活Lore、相关NPC、相关实体/关系与近期/相关日志；未注入不代表不存在。",
    `激活Lore=${activeLoreEntries.length > 0 ? activeLoreEntries.map((item) => `${item.title}:${compactScenarioText(item.content)}`.trim()).join("；") : "无"}`,
    `相关NPC=${relevantNpcs.length > 0 ? relevantNpcs.map(formatScenarioNpc).join("；") : "无"}`,
    `相关实体=${relevantEntities.length > 0 ? relevantEntities.map((item) => `${item.id}:${item.name}[${item.kind}] ${compactScenarioText([item.summary, item.status ? `状态:${item.status}` : "", item.locationId ? `位置:${item.locationId}` : ""].filter(Boolean).join("；"))}`.trim()).join("；") : "无"}`,
    `相关关系=${relevantRelations.length > 0 ? relevantRelations.map((item) => `${item.sourceId}->${item.targetId}[${item.kind};${item.strength}] ${compactScenarioText(item.summary)}`.trim()).join("；") : "无"}`,
    `相关日志=${relevantJournal.length > 0 ? relevantJournal.map((item) => `T${item.turnIndex} ${item.title}:${compactScenarioText(item.summary)}`.trim()).join("；") : "无"}`,
    `规则=${state.mechanics.ruleStyle}${state.mechanics.dicePolicy ? `；${state.mechanics.dicePolicy}` : ""}`,
    `标记=${Object.keys(state.flags).length > 0 ? Object.entries(state.flags).map(([key, value]) => `${key}=${String(value)}`).join("；") : "无"}`,
    `回合数=${state.turnIndex}`
  ];
}

function compactScenarioText(text: string, maxLength = 220): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3)}...`;
}

function normalizeScenarioSearchText(text: string): string {
  return text.toLocaleLowerCase().trim();
}

function uniqueScenarioTerms(terms: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const normalized = normalizeScenarioSearchText(term);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function scoreScenarioExplicitTerms(queryText: string, terms: readonly string[], weight: number): number {
  const normalizedQuery = normalizeScenarioSearchText(queryText);
  if (!normalizedQuery) {
    return 0;
  }
  let score = 0;
  for (const term of uniqueScenarioTerms(terms)) {
    if (normalizedQuery.includes(term)) {
      score += weight;
    }
  }
  return score;
}

function scoreScenarioTextOverlap(queryText: string, candidateText: string, weight: number): number {
  if (!queryText.trim() || !candidateText.trim()) {
    return 0;
  }
  return Math.round(contextTermOverlapScore(queryText, candidateText) * weight);
}

function compareRankedScenarioItems<T>(left: RankedScenarioItem<T>, right: RankedScenarioItem<T>): number {
  return right.score - left.score
    || right.priority - left.priority
    || right.recency - left.recency
    || left.label.localeCompare(right.label);
}

function collectScenarioCurrentLocationEntityIds(state: ScenarioHostSessionState): Set<string> {
  const currentLocation = state.currentLocation ? normalizeScenarioSearchText(state.currentLocation) : "";
  if (!currentLocation) {
    return new Set();
  }
  return new Set(state.entities
    .filter((item) => item.kind === "location")
    .filter((item) => uniqueScenarioTerms([item.id, item.name, ...item.aliases]).some((term) => currentLocation.includes(term) || term.includes(currentLocation)))
    .map((item) => item.id));
}

function rankScenarioLoreEntries(state: ScenarioHostSessionState, queryText: string): RankedScenarioItem<ScenarioHostLoreEntry>[] {
  return state.loreEntries
    .filter((item) => item.enabled)
    .map((item) => {
      const candidateText = [
        item.title,
        item.content,
        ...item.tags,
        ...item.activationKeys
      ].join("\n");
      const score = scoreScenarioExplicitTerms(queryText, item.activationKeys, 8)
        + scoreScenarioExplicitTerms(queryText, item.tags, 4)
        + scoreScenarioExplicitTerms(queryText, [item.title], 3)
        + scoreScenarioTextOverlap(queryText, candidateText, 14);
      return {
        item,
        score,
        priority: item.priority,
        recency: item.updatedAtTurn,
        label: item.title
      };
    });
}

function selectScenarioLoreEntries(state: ScenarioHostSessionState, queryText: string): ScenarioHostLoreEntry[] {
  const ranked = rankScenarioLoreEntries(state, queryText).sort(compareRankedScenarioItems);
  const matched = ranked.filter((item) => item.score > 0).slice(0, SCENARIO_ACTIVE_LORE_LIMIT);
  if (matched.length > 0) {
    return matched.map((item) => item.item);
  }
  return ranked.slice(0, SCENARIO_LORE_BASELINE_LIMIT).map((item) => item.item);
}

function rankScenarioNpcs(state: ScenarioHostSessionState, queryText: string): RankedScenarioItem<ScenarioHostNpc>[] {
  const currentLocation = state.currentLocation ? normalizeScenarioSearchText(state.currentLocation) : "";
  const currentLocationEntityIds = collectScenarioCurrentLocationEntityIds(state);
  return state.npcs.map((item) => {
    const identityTerms = [item.id, item.name, ...item.aliases];
    const candidateText = [
      item.id,
      item.name,
      item.basicInfo,
      item.characterDescription,
      item.statusDescription,
      item.locationId ?? "",
      item.notes,
      ...item.aliases,
      ...item.tags,
      ...item.wornItems.flatMap((worn) => [worn.name, worn.wearPosition, worn.description]),
      ...item.heldItems.flatMap((held) => [held.name, held.description])
    ].join("\n");
    let score = scoreScenarioExplicitTerms(queryText, identityTerms, 8)
      + scoreScenarioExplicitTerms(queryText, item.tags, 3)
      + scoreScenarioTextOverlap(queryText, candidateText, 12);
    if (currentLocation && uniqueScenarioTerms([item.id, item.name, ...item.aliases, item.locationId ?? ""]).some((term) => currentLocation.includes(term) || term.includes(currentLocation))) {
      score += 6;
    }
    if (item.locationId && currentLocationEntityIds.has(item.locationId)) {
      score += 6;
    }
    return {
      item,
      score,
      priority: 3,
      recency: 0,
      label: item.name
    };
  });
}

function selectScenarioNpcs(state: ScenarioHostSessionState, queryText: string): ScenarioHostNpc[] {
  return rankScenarioNpcs(state, queryText)
    .filter((item) => item.score > 0)
    .sort(compareRankedScenarioItems)
    .slice(0, SCENARIO_RELEVANT_NPC_LIMIT)
    .map((item) => item.item);
}

function rankScenarioEntities(state: ScenarioHostSessionState, queryText: string): RankedScenarioItem<ScenarioHostEntity>[] {
  const currentLocation = state.currentLocation ? normalizeScenarioSearchText(state.currentLocation) : "";
  const currentLocationEntityIds = collectScenarioCurrentLocationEntityIds(state);
  return state.entities.map((item) => {
    const identityTerms = [item.id, item.name, ...item.aliases];
    const candidateText = [
      item.id,
      item.name,
      item.kind,
      item.summary,
      item.status,
      item.locationId ?? "",
      item.notes,
      ...item.aliases,
      ...item.tags
    ].join("\n");
    let score = scoreScenarioExplicitTerms(queryText, identityTerms, 8)
      + scoreScenarioExplicitTerms(queryText, item.tags, 3)
      + scoreScenarioTextOverlap(queryText, candidateText, 12);
    if (currentLocation && uniqueScenarioTerms([item.id, item.name, ...item.aliases, item.locationId ?? ""]).some((term) => currentLocation.includes(term) || term.includes(currentLocation))) {
      score += item.kind === "location" ? 10 : 4;
    }
    if (currentLocationEntityIds.has(item.id)) {
      score += 10;
    }
    if (item.locationId && currentLocationEntityIds.has(item.locationId)) {
      score += 6;
    }
    return {
      item,
      score,
      priority: item.kind === "location" ? 2 : 1,
      recency: 0,
      label: item.name
    };
  });
}

function selectScenarioEntities(state: ScenarioHostSessionState, queryText: string): ScenarioHostEntity[] {
  return rankScenarioEntities(state, queryText)
    .filter((item) => item.score > 0)
    .sort(compareRankedScenarioItems)
    .slice(0, SCENARIO_RELEVANT_ENTITY_LIMIT)
    .map((item) => item.item);
}

function rankScenarioRelations(state: ScenarioHostSessionState, queryText: string, selectedSubjectIds: Set<string>): RankedScenarioItem<ScenarioHostRelation>[] {
  return state.relations.map((item) => {
    const candidateText = [
      item.sourceId,
      item.targetId,
      item.kind,
      item.summary
    ].join("\n");
    const selectedEndpointCount = (selectedSubjectIds.has(item.sourceId) ? 1 : 0) + (selectedSubjectIds.has(item.targetId) ? 1 : 0);
    const directScore = scoreScenarioExplicitTerms(queryText, [item.sourceId, item.targetId, item.kind], 4)
      + scoreScenarioTextOverlap(queryText, candidateText, 10);
    const endpointScore = selectedEndpointCount === 2 ? 8 : selectedEndpointCount * 5;
    const score = endpointScore + directScore;
    return {
      item,
      score,
      priority: Math.abs(item.strength),
      recency: item.updatedAtTurn,
      label: `${item.sourceId}->${item.targetId}`
    };
  });
}

function selectScenarioRelations(state: ScenarioHostSessionState, queryText: string, selectedSubjectIds: Set<string>): ScenarioHostRelation[] {
  return rankScenarioRelations(state, queryText, selectedSubjectIds)
    .filter((item) => item.score > 0)
    .sort(compareRankedScenarioItems)
    .slice(0, SCENARIO_RELEVANT_RELATION_LIMIT)
    .map((item) => item.item);
}

function includeScenarioRelationEndpointNpcs(state: ScenarioHostSessionState, selectedNpcs: ScenarioHostNpc[], selectedRelations: ScenarioHostRelation[]): ScenarioHostNpc[] {
  const npcById = new Map(state.npcs.map((item) => [item.id, item]));
  const result = [...selectedNpcs];
  const seen = new Set(result.map((item) => item.id));
  let appendedCount = 0;
  for (const relation of selectedRelations) {
    for (const npcId of [relation.sourceId, relation.targetId]) {
      if (seen.has(npcId) || appendedCount >= SCENARIO_RELATION_ENDPOINT_LIMIT) {
        continue;
      }
      const npc = npcById.get(npcId);
      if (!npc) {
        continue;
      }
      seen.add(npcId);
      result.push(npc);
      appendedCount += 1;
    }
  }
  return result;
}

function includeScenarioRelationEndpointEntities(state: ScenarioHostSessionState, selectedEntities: ScenarioHostEntity[], selectedRelations: ScenarioHostRelation[]): ScenarioHostEntity[] {
  const entityById = new Map(state.entities.map((item) => [item.id, item]));
  const result = [...selectedEntities];
  const seen = new Set(result.map((item) => item.id));
  let appendedCount = 0;
  for (const relation of selectedRelations) {
    for (const entityId of [relation.sourceId, relation.targetId]) {
      if (seen.has(entityId) || appendedCount >= SCENARIO_RELATION_ENDPOINT_LIMIT) {
        continue;
      }
      const entity = entityById.get(entityId);
      if (!entity) {
        continue;
      }
      seen.add(entityId);
      result.push(entity);
      appendedCount += 1;
    }
  }
  return result;
}

function selectScenarioJournalEntries(state: ScenarioHostSessionState, queryText: string, selectedSubjectIds: Set<string>): ScenarioHostJournalEntry[] {
  const latestIds = new Set(state.journal.slice(-5).map((item) => item.id));
  const ranked = state.journal.map((item) => {
    const matchedEntityCount = item.entityIds.filter((id) => selectedSubjectIds.has(id)).length;
    const candidateText = [
      item.title,
      item.summary,
      ...item.entityIds,
      ...item.tags
    ].join("\n");
    const score = (latestIds.has(item.id) ? 3 : 0)
      + matchedEntityCount * 5
      + scoreScenarioExplicitTerms(queryText, item.tags, 3)
      + scoreScenarioExplicitTerms(queryText, item.entityIds, 3)
      + scoreScenarioTextOverlap(queryText, candidateText, 10);
    return {
      item,
      score,
      priority: latestIds.has(item.id) ? 1 : 0,
      recency: item.turnIndex,
      label: item.title
    };
  });
  return ranked
    .filter((item) => item.score > 0)
    .sort(compareRankedScenarioItems)
    .slice(0, SCENARIO_RELEVANT_JOURNAL_LIMIT)
    .map((item) => item.item)
    .sort((left, right) => left.turnIndex - right.turnIndex || left.createdAtMs - right.createdAtMs);
}

function formatScenarioPlayer(player: ScenarioHostSessionState["player"]): string {
  return `${player.displayName} (${player.userId}) ${compactScenarioText([
    player.basicInfo ? `基本信息:${player.basicInfo}` : "",
    player.characterDescription ? `描述:${player.characterDescription}` : "",
    player.statusDescription ? `状态:${player.statusDescription}` : "",
    `穿着:${formatWornItems(player.wornItems)}`,
    `持有:${formatHeldItems(player.heldItems)}`
  ].filter(Boolean).join("；"))}`;
}

function formatScenarioNpc(npc: ScenarioHostNpc): string {
  return `${npc.id}:${npc.name} ${compactScenarioText([
    `基本信息:${npc.basicInfo}`,
    `描述:${npc.characterDescription}`,
    npc.statusDescription ? `状态:${npc.statusDescription}` : "",
    npc.locationId ? `位置:${npc.locationId}` : "",
    `穿着:${formatWornItems(npc.wornItems)}`,
    `持有:${formatHeldItems(npc.heldItems)}`
  ].filter(Boolean).join("；"))}`;
}

function formatWornItems(items: ScenarioHostWornItem[]): string {
  return items.length > 0
    ? items.map((item) => `${item.wearPosition}:${item.name}(${compactScenarioText(item.description, 80)})`).join(", ")
    : "未设定";
}

function formatHeldItems(items: ScenarioHostHeldItem[]): string {
  return items.length > 0
    ? items.map((item) => `${item.name}x${item.quantity}(${compactScenarioText(item.description, 80)})`).join(", ")
    : "未设定";
}

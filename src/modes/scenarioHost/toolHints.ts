export function buildScenarioHostToolHintLines(visibleToolNames: Set<string>): string[] {
  const lines: string[] = [];

  if (hasAnyScenarioTool(visibleToolNames, [
    "get_scenario_state",
    "update_scenario_state",
    "set_current_location",
    "set_scenario_setup_optional_item_status",
    "update_player_character",
    "manage_objective",
    "manage_npc",
    "manage_lore_entry",
    "manage_entity",
    "manage_relation",
    "append_journal_entry",
    "suggest_scenario_details"
  ])) {
    lines.push("场景状态工具用于 scenario_host 内部维护；先 get_scenario_state 再按需查看 scene、玩家角色、NPC、目标、Lore、非角色实体、关系或剧情日志，不要把完整结构化状态原样念给玩家。");
  }

  if (visibleToolNames.has("set_scenario_setup_optional_item_status")) {
    lines.push("Scenario 初始化/配置中 owner 明确表示某个可选项不填、暂无或跳过时，用 set_scenario_setup_optional_item_status 记录该项已跳过；不要用 flags 代替。");
  }

  if (hasAnyScenarioTool(visibleToolNames, [
    "update_scenario_state",
    "set_current_location",
    "set_scenario_setup_optional_item_status",
    "update_player_character",
    "manage_objective",
    "manage_npc",
    "manage_lore_entry",
    "manage_entity",
    "manage_relation",
    "append_journal_entry"
  ])) {
    lines.push("玩家行动导致局势、地点、目标、玩家/NPC 角色状态、穿着、持有物、关系或事实发生持久变化时，必须用对应场景状态工具同步状态；NPC 用 manage_npc，非角色对象用 manage_entity，重大事件、线索确认或场景切换后用 append_journal_entry 留剧情日志；纯氛围描写或未确认猜测不要写入状态。");
  }

  if (visibleToolNames.has("suggest_scenario_details")) {
    lines.push("缺少角色穿着或持有物但已有足够角色描述时，可以调用 suggest_scenario_details 生成候选；候选只是建议，写入 state 前要能从 owner 已确认内容或上下文中成立。");
  }

  return lines;
}

function hasAnyScenarioTool(visibleToolNames: Set<string>, names: string[]): boolean {
  return names.some((name) => visibleToolNames.has(name));
}

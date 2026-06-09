import type { SessionModeSetupToolsetOverride } from "../types.ts";

export function createScenarioHostSetupToolsetOverrides(): SessionModeSetupToolsetOverride[] {
  return [
    {
      toolsetId: "scenario_profile_draft",
      title: "Scenario 资料草稿",
      description: "初始化阶段用于填写当前会话 Scenario 主持资料草稿。",
      toolNames: ["get_scenario_profile", "patch_scenario_profile", "clear_scenario_profile_field"],
      plannerSignals: ["写入当前会话 Scenario 资料"]
    },
    {
      toolsetId: "scenario_runtime_state_draft",
      title: "Scenario 运行态草稿",
      description: "初始化阶段用于记录玩家角色、NPC、地点、目标、关系、Lore 和剧情开局状态。",
      toolNames: [
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
      ],
      plannerSignals: ["写入玩家角色、NPC、穿着、持有物、地点、目标或开局状态"]
    },
    {
      toolsetId: "setup_draft",
      title: "设定草稿",
      description: "以独立消息发送当前场景草稿供用户审阅。",
      toolNames: ["send_setup_draft"],
      plannerSignals: ["发送场景草稿"]
    }
  ];
}

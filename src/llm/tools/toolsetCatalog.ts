export interface ToolsetDefinition {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  plannerSignals?: string[];
  ownerOnly?: boolean;
  debugOnly?: boolean;
  modeUniversal?: boolean;
}

export interface ToolsetView {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  plannerSignals?: string[];
}

export const TOOLSET_DEFINITIONS: ToolsetDefinition[] = [
  {
    modeUniversal: true,
    id: "chat_context",
    title: "会话上下文",
    description: "查看消息、转发、媒体和当前群聊上下文，必要时结束本轮回复。",
    plannerSignals: [
      "查看 reply/forward/image 上下文",
      "查看当前群资料、群公告或群成员",
      "先展开上下文再回复"
    ],
    toolNames: [
      "view_message",
      "view_forward_record",
      "view_current_group_info",
      "list_current_group_announcements",
      "list_current_group_members",
      "chat_file_view_media",
      "chat_file_inspect_media",
      "end_turn_without_reply"
    ]
  },
  {
    id: "memory_profile",
    title: "长期资料与规则",
    description: "读取和维护 persona、全局规则、工具集规则、用户资料与用户长期记忆；适合处理用户自述资料、长期偏好、边界和默认做法。",
    plannerSignals: [
      "长期信息与偏好",
      "读写 persona、规则、资料、长期记忆",
      "用户自述自己的资料信息",
      "长期偏好、边界、默认做法"
    ],
    toolNames: [
      "get_persona",
      "patch_persona",
      "clear_persona_field",
      "list_global_rules",
      "upsert_global_rule",
      "remove_global_rule",
      "list_toolset_rules",
      "upsert_toolset_rule",
      "remove_toolset_rule",
      "get_user_profile",
      "patch_user_profile",
      "list_user_memories",
      "upsert_user_memory",
      "remove_user_memory",
      "replace_user_memory",
      "register_known_user",
      "set_user_special_role"
    ]
  },
  {
    id: "persona_profile_draft",
    title: "全局人格草稿",
    description: "读取和修改当前会话中的 persona 草稿。",
    ownerOnly: true,
    plannerSignals: [
      "编辑 persona 草稿",
      "查看当前 persona 草稿"
    ],
    toolNames: [
      "get_persona",
      "patch_persona",
      "clear_persona_field"
    ]
  },
  {
    id: "rp_profile_draft",
    title: "RP 资料草稿",
    description: "读取和修改当前会话中的 RP 全局资料草稿。",
    ownerOnly: true,
    plannerSignals: [
      "编辑 RP 草稿",
      "查看当前 RP 草稿"
    ],
    toolNames: [
      "get_rp_profile",
      "patch_rp_profile",
      "clear_rp_profile_field"
    ]
  },
  {
    id: "scenario_profile_draft",
    title: "Scenario 资料草稿",
    description: "读取和修改当前会话中的 Scenario 全局资料草稿。",
    ownerOnly: true,
    plannerSignals: [
      "编辑 Scenario 草稿",
      "查看当前 Scenario 草稿"
    ],
    toolNames: [
      "get_scenario_profile",
      "patch_scenario_profile",
      "clear_scenario_profile_field"
    ]
  },
  {
    id: "conversation_navigation",
    title: "跨会话导航",
    description: "检索可访问会话并读取上下文。",
    plannerSignals: [
      "跨会话找历史",
      "读取别的聊天上下文"
    ],
    toolNames: [
      "search_accessible_conversations",
      "get_conversation_context"
    ]
  },
  {
    id: "chat_delegation",
    title: "会话委派",
    description: "查找目标会话并把任务委派到其他聊天。",
    plannerSignals: [
      "转告或委派到其他会话",
      "查找目标聊天并代发"
    ],
    toolNames: [
      "search_chat_targets",
      "delegate_message_to_chat"
    ]
  },
  {
    id: "web_research",
    title: "网页检索与浏览",
    description: "搜索网页、打开页面、交互与截图。",
    plannerSignals: [
      "外部信息与事实核查",
      "网页浏览、交互、截图"
    ],
    toolNames: [
      "ground_with_google_search",
      "search_with_iqs_lite_advanced",
      "open_page",
      "inspect_page",
      "interact_with_page",
      "close_page",
      "download_asset",
      "capture_screenshot",
      "list_browser_profiles",
      "inspect_browser_profile",
      "save_browser_profile",
      "clear_browser_profile"
    ]
  },
  {
    id: "shell_runtime",
    title: "Shell 运行时",
    description: "执行与交互 terminal 会话，并复用 terminal resource。",
    plannerSignals: [
      "运行命令与终端交互",
      "脚本、日志、进程排障"
    ],
    ownerOnly: true,
    toolNames: [
      "terminal_list",
      "terminal_run",
      "terminal_start",
      "terminal_read",
      "terminal_write",
      "terminal_key",
      "terminal_signal",
      "terminal_stop"
    ]
  },
  {
    id: "local_file_io",
    title: "本地文件",
    description: "浏览、编辑、搜索和发送本地文件。",
    plannerSignals: [
      "读写或搜索本地文件",
      "按路径发送本地文件"
    ],
    toolNames: [
      "local_file_ls",
      "local_file_mkdir",
      "local_file_read",
      "local_file_write",
      "local_file_patch",
      "local_file_move",
      "local_file_delete",
      "local_file_search",
      "local_file_view_media",
      "local_file_inspect_media",
      "local_file_send_to_chat"
    ]
  },
  {
    id: "chat_file_io",
    title: "聊天文件",
    description: "查看和发送已登记的 chat file。",
    plannerSignals: [
      "查看聊天导入文件",
      "发送已登记图片或附件"
    ],
    toolNames: [
      "chat_file_list",
      "chat_file_view_media",
      "chat_file_inspect_media",
      "chat_file_send_to_chat"
    ]
  },
  {
    id: "social_admin",
    title: "社交管理",
    description: "处理好友/群请求和聊天白名单。",
    plannerSignals: [
      "好友、群、白名单审批"
    ],
    ownerOnly: true,
    toolNames: [
      "search_friends",
      "search_joined_groups",
      "list_pending_friend_requests",
      "list_pending_group_requests",
      "respond_request",
      "set_chat_permission"
    ]
  },
  {
    id: "scheduler_admin",
    title: "定时任务管理",
    description: "查看、创建和管理计划任务。",
    plannerSignals: [
      "提醒、延时、周期任务"
    ],
    ownerOnly: true,
    toolNames: [
      "list_scheduled_jobs",
      "create_scheduled_job",
      "manage_scheduled_job"
    ]
  },
  {
    id: "comfy_image",
    title: "Comfy 图像生成",
    description: "仅用于生成新图像（文生图）。不用于下载已有文件或图片。",
    plannerSignals: [
      "生成新图片或重绘"
    ],
    toolNames: [
      "generate_image_with_comfyui"
    ]
  },
  {
    id: "scenario_host_state",
    title: "场景状态",
    description: "读取和维护 scenario_host 会话的场景状态。",
    plannerSignals: [
      "推进场景状态",
      "维护地点、目标、背包或世界事实"
    ],
    toolNames: [
      "get_scenario_state",
      "update_scenario_state",
      "set_current_location",
      "manage_objective",
      "manage_inventory",
      "append_world_fact"
    ]
  },
  {
    modeUniversal: true,
    id: "time_utils",
    title: "时间工具",
    description: "查询当前时间。",
    plannerSignals: [
      "当前精确时间或日期"
    ],
    toolNames: [
      "get_current_time"
    ]
  },
  {
    modeUniversal: true,
    id: "dice_roller",
    title: "骰子",
    description: "随机投骰并计算骰子表达式。",
    plannerSignals: [
      "投骰、掷骰、roll dice",
      "D20、D6、3D6+5"
    ],
    toolNames: [
      "roll_dice"
    ]
  },
  {
    id: "session_mode_control",
    title: "会话模式控制",
    description: "查看并切换当前会话模式。",
    plannerSignals: [
      "切换当前会话模式"
    ],
    modeUniversal: true,
    toolNames: [
      "list_session_modes",
      "switch_session_mode"
    ]
  },
  {
    id: "debug_owner",
    title: "调试导出",
    description: "导出调试字面量（仅调试模式）。",
    ownerOnly: true,
    debugOnly: true,
    toolNames: [
      "dump_debug_literals"
    ]
  }
];

export function toToolsetView(
  toolset: ToolsetDefinition,
  visibleToolNames: Set<string>
): ToolsetView | null {
  const filteredToolNames = toolset.toolNames.filter((name) => visibleToolNames.has(name));
  if (filteredToolNames.length === 0) {
    return null;
  }
  return {
    id: toolset.id,
    title: toolset.title,
    description: toolset.description,
    toolNames: filteredToolNames,
    ...(toolset.plannerSignals && toolset.plannerSignals.length > 0
      ? { plannerSignals: toolset.plannerSignals }
      : {})
  };
}

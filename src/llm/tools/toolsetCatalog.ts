export interface ToolsetDefinition {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  promptGuidance?: string[];
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
  promptGuidance?: string[];
  plannerSignals?: string[];
}

export const TOOLSET_DEFINITIONS: ToolsetDefinition[] = [
  {
    modeUniversal: true,
    id: "chat_context",
    title: "会话上下文",
    description: "查看消息、转发和媒体上下文，必要时结束本轮回复。",
    promptGuidance: [
      "需要补足 reply、forward、图片或表情上下文时，先展开引用再继续判断。",
      "结构化 id 必须逐字复制；看完上下文后只保留和当前回复相关的部分。",
      "只有最新消息明显只是收尾、不需要继续接话时，才结束本轮。"
    ],
    plannerSignals: [
      "查看 reply/forward/image 上下文",
      "先展开上下文再回复"
    ],
    toolNames: [
      "view_message",
      "view_forward_record",
      "chat_file_view_media",
      "end_turn_without_reply"
    ]
  },
  {
    id: "memory_profile",
    title: "长期资料与规则",
    description: "读取和维护 persona、全局规则、工具集规则、用户资料与用户长期记忆；适合处理用户自述资料、长期偏好、边界和默认做法。",
    promptGuidance: [
      "处理长期信息前先读现有资料，避免重复写入或写出冲突。",
      "按决策树选择写入目标：persona -> global_rules -> toolset_rules -> user_profile -> user_memories。",
      "同一事实不要重复写进多个类别；优先更新已有相近条目。",
      "遇到用户自述稳定资料或明确提出长期偏好/边界时，优先带上这组工具，先读取再判断是否需要写入。"
    ],
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
      "register_known_user",
      "set_user_special_role"
    ]
  },
  {
    id: "persona_profile_draft",
    title: "全局人格草稿",
    description: "读取和修改当前会话中的 persona 草稿。",
    ownerOnly: true,
    promptGuidance: [
      "当前只允许围绕 persona 草稿工作；不要改全局规则、工具集规则或用户资料。",
      "修改的是当前会话草稿，不是正式持久化数据。"
    ],
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
    promptGuidance: [
      "当前只允许围绕 RP 全局资料草稿工作；不要改 persona 或其他长期规则。",
      "修改的是当前会话草稿，不是正式持久化数据。"
    ],
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
    promptGuidance: [
      "当前只允许围绕 Scenario 全局资料草稿工作；不要改 persona 或其他长期规则。",
      "修改的是当前会话草稿，不是正式持久化数据。"
    ],
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
    promptGuidance: [
      "只有当前会话信息确实不够时，才跨会话补上下文。",
      "先找相关会话，再读取最小必要范围；不要把别的会话信息混进当前结论。"
    ],
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
    promptGuidance: [
      "需要把消息转到别的会话时，先确认目标会话，再执行委派。",
      "不要猜 sessionId，也不要把面向当前会话的话误发到其他聊天。"
    ],
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
    promptGuidance: [
      "只有当前问题依赖外部信息或网页状态时，才进入网页检索与浏览。",
      "先搜索或打开页面，再检查页面结构后交互；页面变化后重新检查，不要沿用旧定位。",
      "需要保存网页资源或上传本地文件时，再配合文件工具处理。"
    ],
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
    description: "执行与交互 shell 会话，并复用 live_resource。",
    promptGuidance: [
      "需要运行命令、看日志或继续终端任务时，优先复用现有 shell 资源。",
      "命令目标要具体，先验证当前状态，再做下一步；不要为了绕过限制而乱开新会话。"
    ],
    plannerSignals: [
      "运行命令与终端交互",
      "脚本、日志、进程排障"
    ],
    ownerOnly: true,
    toolNames: [
      "list_live_resources",
      "shell_run",
      "shell_interact",
      "shell_read",
      "shell_signal"
    ]
  },
  {
    id: "local_file_io",
    title: "本地文件",
    description: "浏览、编辑、搜索和发送本地文件。",
    promptGuidance: [
      "处理本地文件时，先列出、搜索或查看现有内容，再读写或发送。",
      "需要下载网页资源、保存中间结果或把本地产物发回聊天时，再使用这一组能力。"
    ],
    plannerSignals: [
      "读写或搜索本地文件",
      "按路径发送本地文件"
    ],
    toolNames: [
      "download_asset",
      "local_file_ls",
      "local_file_read",
      "local_file_write",
      "local_file_patch",
      "local_file_move",
      "local_file_delete",
      "local_file_search",
      "local_file_view_media",
      "local_file_send_to_chat"
    ]
  },
  {
    id: "chat_file_io",
    title: "聊天文件",
    description: "查看和发送已登记的 chat file。",
    promptGuidance: [
      "需要查看聊天导入图片、网页下载、截图或生成结果时，先列出现有 chat file。",
      "发送已登记文件时优先用 file_ref；file_id 是稳定主键。"
    ],
    plannerSignals: [
      "查看聊天导入文件",
      "发送已登记图片或附件"
    ],
    toolNames: [
      "chat_file_list",
      "chat_file_view_media",
      "chat_file_send_to_chat"
    ]
  },
  {
    id: "social_admin",
    title: "社交管理",
    description: "处理好友/群请求和聊天白名单。",
    promptGuidance: [
      "这组能力只用于 owner 明确提出的好友、群或白名单管理操作。",
      "先确认对象和动作，再审批或修改权限；不要把普通聊天误当成管理指令。"
    ],
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
    promptGuidance: [
      "只有明确存在未来时间点、延后处理或周期执行需求时，才创建计划任务。",
      "任务说明必须写成触发当时也能独立执行的完整指令，不依赖当前轮隐含上下文。"
    ],
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
    promptGuidance: [
      "只在确实要生成新图时使用；下载已有图片或发送现成文件不属于这一组能力。",
      "出图前先把主体、场景和约束想清楚；生成完成后再决定是先看图、直接发图还是继续调整。"
    ],
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
    promptGuidance: [
      "主持剧情时先读取场景状态，再按需更新地点、目标、背包或世界事实。",
      "状态工具主要用于内部维护，不要把完整状态原样念给玩家。"
    ],
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
    promptGuidance: [
      "默认先用消息时间和上下文理解相对时间；只有需要当前精确时刻时再取当前时间。"
    ],
    plannerSignals: [
      "当前精确时间或日期"
    ],
    toolNames: [
      "get_current_time"
    ]
  },
  {
    id: "session_mode_control",
    title: "会话模式控制",
    description: "查看并切换当前会话模式。",
    promptGuidance: [
      "只有用户明确要求切换当前会话模式时才执行切换。",
      "切换前先查看可用模式；如果没有其他模式可切，只需明确说明。"
    ],
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
    promptGuidance: [
      "只有 owner 明确要求看原始调试材料时，才导出调试字面量。",
      "调试导出属于直接展示内部材料，不要在普通回答里混入这类内容。"
    ],
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
    ...(toolset.promptGuidance && toolset.promptGuidance.length > 0
      ? { promptGuidance: toolset.promptGuidance }
      : {}),
    ...(toolset.plannerSignals && toolset.plannerSignals.length > 0
      ? { plannerSignals: toolset.plannerSignals }
      : {})
  };
}

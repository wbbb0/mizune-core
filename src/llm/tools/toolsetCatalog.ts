export interface ToolsetDefinition {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  plannerSignals?: string[];
  features?: Array<{ toolNames: string[]; description: string; signals?: string[] }>;
  ownerOnly?: boolean;
  debugOnly?: boolean;
  modeUniversal?: { defaultEnabled: boolean };
  availableDuringSetup?: boolean;
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
    id: "speech_generation", title: "语音生成", availableDuringSetup: true,
    description: "把文本生成可发送的语音资产；可选择声音、语速和说话风格。",
    plannerSignals: ["生成语音、朗读或有声内容"], toolNames: ["generate_speech"]
  },
  {
    id: "native_decisions", title: "原生决策",
    description: "根据文本、图片和结构化证据计算条件概率、分类或评分。",
    plannerSignals: ["按固定选项分类、条件概率或评分"], toolNames: ["make_decision"]
  },
  {
    features: [
      { toolNames: ["sticker_collect", "sticker_update", "sticker_remove"], description: "收藏、整理和淘汰已有表情", signals: ["整理已有表情"] },
      { toolNames: ["sticker_qq_list"], description: "查看并导入 QQ 收藏", signals: ["查看 QQ 收藏"] },
      { toolNames: ["sticker_search", "sticker_send"], description: "查找和发送精选表情", signals: ["使用精选表情"] }
    ],
    id: "sticker_library",
    title: "精选表情库",
    description: "按需收藏、整理和淘汰值得复用的表情，或从QQ收藏导入；不是每轮都需要整理。",
    modeUniversal: { defaultEnabled: true },
    plannerSignals: ["收藏或整理表情", "维护表情描述、使用情景和风格", "查看QQ收藏"],
    toolNames: ["sticker_collect", "sticker_update", "sticker_remove", "sticker_qq_list", "sticker_search", "sticker_send"]
  },
  {
    modeUniversal: { defaultEnabled: true },
    features: [
      { toolNames: ["view_message", "download_message_file"], description: "读取原生消息及消息附件", signals: ["查看原生消息"] },
      { toolNames: ["view_forward_record"], description: "展开缓存转发记录", signals: ["展开转发上下文"] },
      { toolNames: ["resolve_media_reference", "asset_media_view", "asset_media_inspect"], description: "恢复、查看和精读媒体", signals: ["查看媒体上下文"] },
      { toolNames: ["view_current_group_info"], description: "查询当前群资料", signals: ["群资料"] },
      { toolNames: ["list_current_group_announcements", "view_current_group_announcement"], description: "读取当前群公告", signals: ["群公告"] },
      { toolNames: ["list_current_group_files", "download_current_group_file"], description: "查找和下载当前群文件", signals: ["群文件"] },
      { toolNames: ["list_current_group_members"], description: "查询当前群成员", signals: ["群成员"] },
      { toolNames: ["sticker_search", "sticker_send"], description: "使用精选表情" },
      { toolNames: ["end_turn_without_reply"], description: "按需结束本轮回复" }
    ],
    id: "chat_context",
    title: "会话上下文",
    description: "查看消息、转发、媒体和当前群聊上下文，必要时结束本轮回复。",
    plannerSignals: [
      "查看 reply/forward/image 上下文",
      "查看当前群资料、群公告全文、群文件或群成员",
      "先展开上下文再回复"
    ],
    toolNames: [
      "sticker_search",
      "sticker_send",
      "view_message",
      "resolve_media_reference",
      "download_message_file",
      "view_forward_record",
      "view_current_group_info",
      "list_current_group_announcements",
      "view_current_group_announcement",
      "list_current_group_files",
      "download_current_group_file",
      "list_current_group_members",
      "asset_media_view",
      "asset_media_inspect",
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
      "list_character_sections", "read_character_section", "edit_character_section",
      "get_persona",
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
    id: "scenario_profile_draft",
    title: "Scenario 资料草稿",
    description: "读取和修改当前会话中的 Scenario 资料草稿。",
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
    availableDuringSetup: true,
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
    features: [
      { toolNames: ["ground_with_google_search"], description: "搜索外部网页" },
      { toolNames: ["search_with_iqs_lite_advanced"], description: "执行可控网页检索" },
      { toolNames: ["open_page"], description: "打开并阅读网页" },
      { toolNames: ["inspect_page"], description: "检查页面结构" },
      { toolNames: ["interact_with_page"], description: "与页面交互" },
      { toolNames: ["capture_screenshot"], description: "截取页面图片" },
      { toolNames: ["download_asset"], description: "下载页面资源" },
      { toolNames: ["list_browser_profiles", "inspect_browser_profile", "save_browser_profile", "clear_browser_profile"], description: "管理浏览器配置" }
    ],
    id: "web_research",
    availableDuringSetup: true,
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
      "list_live_resources",
      "read_download_resource",
      "cancel_download_resource",
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
      "terminal_send_lines",
      "terminal_key",
      "terminal_signal",
      "terminal_stop"
    ]
  },
  {
    features: [
      { toolNames: ["filesystem_list"], description: "浏览本地文件" },
      { toolNames: ["filesystem_read"], description: "读取本地文本" },
      { toolNames: ["filesystem_write", "filesystem_patch", "filesystem_move", "filesystem_copy", "filesystem_delete"], description: "编辑和整理本地文件" },
      { toolNames: ["filesystem_search"], description: "搜索本地文件" },
      { toolNames: ["filesystem_media_view", "filesystem_media_inspect"], description: "查看和精读本地图片" },
      { toolNames: ["filesystem_send_to_chat"], description: "发送本地文件" },
      { toolNames: ["workspace_create", "workspace_close", "workspace_export", "workspace_clone", "workspace_extract", "workspace_pack"], description: "创建和管理临时工作区" },
      { toolNames: ["asset_export_to_filesystem"], description: "将登记资源导出到本地" }
    ],
    id: "filesystem_io",
    availableDuringSetup: true,
    title: "本地文件",
    description: "浏览、编辑、搜索和发送明确路径的文件，或创建一天有效的临时工作区处理下载文件。",
    plannerSignals: [
      "读写或搜索本地文件",
      "按路径发送本地文件"
    ],
    toolNames: [
      "workspace_create",
      "workspace_close",
      "workspace_export",
      "workspace_clone",
      "workspace_extract",
      "workspace_pack",
      "list_live_resources",
      "asset_export_to_filesystem",
      "filesystem_list",
      "filesystem_mkdir",
      "filesystem_read",
      "filesystem_write",
      "filesystem_patch",
      "filesystem_move",
      "filesystem_copy",
      "filesystem_delete",
      "filesystem_search",
      "filesystem_media_view",
      "filesystem_media_inspect",
      "filesystem_send_to_chat"
    ]
  },
  {
    features: [
      { toolNames: ["asset_list"], description: "查找已登记资源" },
      { toolNames: ["start_download_resource", "read_download_resource", "pause_download_resource", "resume_download_resource", "cancel_download_resource"], description: "启动并管理资源下载" },
      { toolNames: ["asset_document_overview", "asset_document_read", "asset_document_search"], description: "浏览和搜索登记文档" },
      { toolNames: ["asset_document_inspect"], description: "精读登记文档" },
      { toolNames: ["asset_media_view", "asset_media_inspect"], description: "查看和精读媒体" },
      { toolNames: ["asset_image_transform"], description: "变换图片" },
      { toolNames: ["asset_local_path"], description: "获取资源本地路径" },
      { toolNames: ["asset_export_to_filesystem"], description: "导出资源到本地" },
      { toolNames: ["asset_send_to_chat"], description: "发送已登记资源" }
    ],
    id: "asset_io",
    availableDuringSetup: true,
    title: "登记资源",
    description: "查看、解析、搜索和发送已登记附件，或管理资源下载。WebUI 上传文件已登记，使用 asset 文档工具读取，无需再次下载。",
    plannerSignals: [
      "查看聊天导入文件",
      "从 URL 下载文件并管理下载任务",
      "发送已登记图片或附件",
      "裁剪、旋转、翻转、拉伸或转换图片格式"
    ],
    toolNames: [
      "asset_list",
      "list_live_resources",
      "start_download_resource",
      "read_download_resource",
      "pause_download_resource",
      "resume_download_resource",
      "cancel_download_resource",
      "asset_document_overview",
      "asset_document_read",
      "asset_document_search",
      "asset_document_inspect",
      "asset_media_view",
      "asset_media_inspect",
      "asset_image_transform",
      "asset_local_path",
      "asset_export_to_filesystem",
      "asset_send_to_chat"
    ]
  },
  {
    features: [
      { toolNames: ["self_account_view"], description: "查看当前账号资料", signals: ["查看账号资料"] },
      { toolNames: ["self_account_avatar_set", "self_account_signature_set"], description: "更新当前账号资料", signals: ["修改账号资料"] },
      { toolNames: ["search_friends", "search_joined_groups"], description: "查找好友或已加入群", signals: ["查找联系人"] },
      { toolNames: ["list_pending_friend_requests", "list_pending_group_requests", "respond_request"], description: "查看并处理好友或群请求", signals: ["好友或群申请审批"] },
      { toolNames: ["set_chat_permission"], description: "设置聊天白名单权限", signals: ["聊天白名单"] }
    ],
    id: "social_admin",
    title: "社交管理",
    description: "处理好友/群请求和聊天白名单。",
    plannerSignals: [
      "好友、群、白名单审批"
    ],
    ownerOnly: true,
    toolNames: [
      "self_account_view",
      "self_account_avatar_set",
      "self_account_signature_set",
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
    id: "image_generation",
    availableDuringSetup: true,
    title: "通用图片生成",
    description: "通过标准图像接口生成新图片，使用生图路由选择的模型。不用于下载已有图片。",
    plannerSignals: ["生成新图片或文生图"],
    toolNames: ["generate_image"]
  },
  {
    id: "comfy_image",
    availableDuringSetup: true,
    title: "ComfyUI 图片生成",
    description: "通过已配置的 ComfyUI 工作流模板异步生成图片。不用于下载已有图片。",
    plannerSignals: ["使用 ComfyUI 或指定工作流生成图片"],
    toolNames: ["generate_image_with_comfyui"]
  },
  {
    id: "scenario_host_state",
    title: "场景状态",
    description: "读取和维护 scenario_host 会话的场景状态。",
    plannerSignals: [
      "推进场景状态",
      "维护玩家角色、NPC、穿着、持有物、地点、目标、Lore、实体、关系或剧情日志",
      "根据角色描述补全穿着或随身物品候选"
    ],
    toolNames: [
      "get_scenario_state",
      "update_scenario_state",
      "set_current_location",
      "update_player_character",
      "manage_objective",
      "manage_npc",
      "manage_lore_entry",
      "manage_entity",
      "manage_relation",
      "append_journal_entry",
      "suggest_scenario_details"
    ]
  },
  {
    id: "stateful_rp_state",
    title: "沉浸状态 RP 状态",
    description: "初始化、读取和修改 stateful_rp 会话的身体感官、服饰穿戴、私密配饰、心理反差、关系张力与世界时间状态。",
    plannerSignals: [
      "初始化或重设沉浸状态 RP 开局状态",
      "换装、脱衣、穿戴或调整私密道具、洗澡清洁、如厕、身体感官突变",
      "更新表里情绪、情欲羞耻、短期微意图、关系进展或约定",
      "切换场景地点、分开或重逢、跳过时间、处理 # 场外导演指令"
    ],
    toolNames: ["list_character_sections", "read_character_section", "edit_character_section"]
  },
  {
    modeUniversal: { defaultEnabled: true },
    id: "time_utils",
    title: "时间工具",
    description: "查询当前时间，或在当前会话内短暂等待。",
    plannerSignals: [
      "当前精确时间或日期",
      "等待几秒后继续检查当前会话任务状态"
    ],
    toolNames: [
      "get_current_time",
      "runtime_wait",
      "delivery_status"
    ]
  },
  {
    modeUniversal: { defaultEnabled: true },
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
    modeUniversal: { defaultEnabled: true },
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
  const partial = filteredToolNames.length !== toolset.toolNames.length;
  const features = toolset.features?.filter((feature) => feature.toolNames.every((name) => visibleToolNames.has(name)));
  const descriptions = features?.map((feature) => feature.description) ?? [];
  const signals = features?.flatMap((feature) => feature.signals ?? [feature.description]) ?? [];
  return {
    id: toolset.id,
    title: toolset.title,
    description: !partial ? toolset.description
      : descriptions.length ? `${descriptions.join("；")}。`
      : `${toolset.title}；当前可用操作：${filteredToolNames.join("、")}。`,
    toolNames: filteredToolNames,
    ...(toolset.plannerSignals && toolset.plannerSignals.length > 0
      ? { plannerSignals: !partial ? toolset.plannerSignals
        : signals.length ? signals : filteredToolNames.map((name) => `使用 ${name}`) }
      : {})
  };
}

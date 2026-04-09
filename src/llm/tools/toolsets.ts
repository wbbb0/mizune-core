import type { AppConfig } from "#config/config.ts";
import { getBuiltinToolNames } from "#llm/builtinTools.ts";
import type { BuiltinToolContext, Relationship } from "./core/shared.ts";

export interface ToolsetDefinition {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  ownerOnly?: boolean;
  debugOnly?: boolean;
}

export interface ToolsetView {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
}

export const TURN_PLANNER_ALWAYS_TOOL_NAMES = [
  "list_available_toolsets",
  "request_toolset"
] as const;

const TOOLSET_DEFINITIONS: ToolsetDefinition[] = [
  {
    id: "chat_context",
    title: "会话上下文",
    description: "查看消息、转发和媒体上下文，必要时结束本轮回复。",
    toolNames: [
      "view_message",
      "view_forward_record",
      "view_media",
      "end_turn_without_reply"
    ]
  },
  {
    id: "memory_profile",
    title: "记忆与资料",
    description: "读取和维护用户资料、长期记忆与 persona。",
    toolNames: [
      "get_user_profile",
      "remember_user_profile",
      "read_memory",
      "write_memory",
      "remove_memory",
      "register_known_user",
      "set_user_special_role"
    ]
  },
  {
    id: "conversation_navigation",
    title: "跨会话导航",
    description: "检索可访问会话并读取上下文。",
    toolNames: [
      "search_accessible_conversations",
      "get_conversation_context"
    ]
  },
  {
    id: "chat_delegation",
    title: "会话委派",
    description: "查找目标会话并把任务委派到其他聊天。",
    toolNames: [
      "search_chat_targets",
      "delegate_message_to_chat"
    ]
  },
  {
    id: "web_research",
    title: "网页检索与浏览",
    description: "搜索网页、打开页面、交互、截图与下载资源。",
    toolNames: [
      "ground_with_google_search",
      "search_with_iqs_lite_advanced",
      "open_page",
      "inspect_page",
      "interact_with_page",
      "close_page",
      "capture_screenshot",
      "download_asset",
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
    id: "workspace_io",
    title: "工作区文件",
    description: "浏览与编辑 workspace 文件，以及发送工作区媒体。",
    toolNames: [
      "list_workspace_items",
      "stat_workspace_item",
      "read_workspace_file",
      "write_workspace_file",
      "patch_workspace_file",
      "mkdir_workspace_dir",
      "move_workspace_item",
      "delete_workspace_item",
      "list_workspace_files",
      "send_workspace_file_to_chat"
    ]
  },
  {
    id: "social_admin",
    title: "社交管理",
    description: "处理好友/群请求和聊天白名单。",
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
    description: "提交 ComfyUI 图像任务。",
    toolNames: [
      "generate_image_with_comfyui"
    ]
  },
  {
    id: "time_utils",
    title: "时间工具",
    description: "查询当前时间。",
    toolNames: [
      "get_current_time"
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

export function listTurnToolsets(input: {
  config: AppConfig;
  relationship: Relationship;
  currentUser: BuiltinToolContext["currentUser"];
  modelRef: string[];
  includeDebugTools: boolean;
  setupMode?: boolean;
}): ToolsetView[] {
  if (input.setupMode) {
    return [{
      id: "memory_profile",
      title: "记忆与资料",
      description: "初始化阶段仅允许写入 persona 相关资料。",
      toolNames: ["read_memory", "write_memory"]
    }];
  }

  const visibleToolNames = new Set(getBuiltinToolNames(
    input.relationship,
    input.currentUser,
    input.config,
    {
      modelRef: input.modelRef,
      includeDebugTools: input.includeDebugTools
    }
  ));

  return TOOLSET_DEFINITIONS
    .filter((toolset) => !(toolset.ownerOnly && input.relationship !== "owner"))
    .filter((toolset) => !(toolset.debugOnly && !input.includeDebugTools))
    .map((toolset) => ({
      ...toolset,
      toolNames: toolset.toolNames.filter((name) => visibleToolNames.has(name))
    }))
    .filter((toolset) => toolset.toolNames.length > 0)
    .map((toolset) => ({
      id: toolset.id,
      title: toolset.title,
      description: toolset.description,
      toolNames: toolset.toolNames
    }));
}

export function resolveToolNamesFromToolsets(
  toolsets: ToolsetView[],
  selectedToolsetIds: string[]
): string[] {
  const selectedSet = new Set(selectedToolsetIds);
  return Array.from(new Set(
    toolsets
      .filter((toolset) => selectedSet.has(toolset.id))
      .flatMap((toolset) => toolset.toolNames)
  ));
}


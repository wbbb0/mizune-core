import type { LlmToolCall } from "#llm/provider/providerTypes.ts";
import type { ToolExecutionEffect } from "#llm/toolExecutionScheduler.ts";

const READ_ONLY_TOOL_RESOURCES: Record<string, readonly string[]> = {
  get_current_time: ["time:current"],
  roll_dice: ["random:dice"],
  get_runtime_config: ["runtime:config"],
  echo: [],
  list_live_resources: ["browser:*", "terminal:*", "download:*"],
  read_download_resource: ["download:*"],
  list_available_toolsets: ["toolsets:*"],
  list_session_modes: ["session_modes:*"],
  list_scheduled_jobs: ["scheduled_jobs:*"],
  get_persona: ["persona:*"],
  get_rp_profile: ["rp_profile:*"],
  get_scenario_profile: ["scenario_profile:*"],
  list_global_rules: ["global_rules:*"],
  list_toolset_rules: ["toolset_rules:*"],
  get_user_profile: ["user_profile:*"],
  list_user_memories: ["user_memories:*"],
  search_friends: ["onebot_contacts:*"],
  search_joined_groups: ["onebot_contacts:*"],
  view_current_group_info: ["onebot_group:*"],
  list_current_group_announcements: ["onebot_group:*"],
  view_current_group_announcement: ["onebot_group:*"],
  list_current_group_files: ["onebot_group:*"],
  list_current_group_members: ["onebot_group:*"],
  list_pending_friend_requests: ["requests:*"],
  list_pending_group_requests: ["requests:*"],
  search_accessible_conversations: ["conversations:*"],
  get_conversation_context: ["conversations:*"],
  view_message: ["messages:*"],
  view_forward_record: ["forwards:*"],
  asset_list: ["chat_file:*"],
  asset_media_view: ["chat_file:*"],
  filesystem_media_view: ["filesystem:*"],
  ground_with_google_search: ["web_search:*"],
  search_with_iqs_lite_advanced: ["web_search:*"],
  list_browser_profiles: ["browser_profile:*"],
  inspect_browser_profile: ["browser_profile:*"],
  get_scenario_state: ["scenario_state:*"]
};

export function analyzeBuiltinToolConcurrency(toolCall: LlmToolCall): ToolExecutionEffect {
  const toolName = toolCall.function.name;
  if (toolName === "end_turn_without_reply") {
    return { kind: "terminal_barrier" };
  }

  const readOnlyResources = READ_ONLY_TOOL_RESOURCES[toolName];
  if (readOnlyResources) {
    return parallel(readOnlyResources, []);
  }

  const args = parseArgs(toolCall.function.arguments);
  switch (toolName) {
    case "filesystem_list":
    case "filesystem_read":
      return parallel([localFileKey(getStringArg(args, "path"))], []);
    case "filesystem_search":
      return parallel([localFileTreeKey(getStringArg(args, "path"))], []);
    case "filesystem_write":
    case "filesystem_patch":
    case "filesystem_delete":
    case "filesystem_mkdir":
      return parallel([], [localFileKey(getStringArg(args, "path"))]);
    case "filesystem_move":
      return parallel([], [
        localFileKey(getStringArg(args, "from_path")),
        localFileKey(getStringArg(args, "to_path"))
      ]);
    case "terminal_list":
      return parallel(["terminal:*"], []);
    case "terminal_read":
      return parallel([terminalKey(getStringArg(args, "resource_id"))], []);
    case "terminal_write":
    case "terminal_send_lines":
    case "terminal_key":
    case "terminal_signal":
    case "terminal_stop":
      return parallel([], [terminalKey(getStringArg(args, "resource_id"))]);
    case "cancel_download_resource":
      return parallel([], [downloadKey(getStringArg(args, "resource_id"))]);
    case "download_current_group_file":
      return parallel(["onebot_group:*"], ["download:*", "chat_file:*"]);
    case "download_message_file":
      return parallel(["messages:*"], ["chat_file:*"]);
    case "inspect_page":
      return parallel([browserPageKey(getStringArg(args, "resource_id"))], []);
    case "capture_screenshot":
      return parallel([browserPageKey(getStringArg(args, "resource_id"))], ["chat_file:*"]);
    case "interact_with_page":
    case "close_page":
      return parallel([], [browserPageKey(getStringArg(args, "resource_id"))]);
    case "download_asset":
      return parallel(
        getStringArg(args, "resource_id") ? [browserPageKey(getStringArg(args, "resource_id"))] : ["web_download:*"],
        ["download:*", "chat_file:*"]
      );
    default:
      return { kind: "barrier" };
  }
}

function parallel(reads: readonly string[], writes: readonly string[]): ToolExecutionEffect {
  return {
    kind: "parallel",
    reads,
    writes
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function localFileKey(path: string | null): string {
  return `filesystem:${path ?? "*"}`;
}

function localFileTreeKey(path: string | null): string {
  return path ? `filesystem:${path}:*` : "filesystem:*";
}

function terminalKey(resourceId: string | null): string {
  return `terminal:${resourceId ?? "*"}`;
}

function downloadKey(resourceId: string | null): string {
  return `download:${resourceId ?? "*"}`;
}

function browserPageKey(resourceId: string | null): string {
  return `browser_page:${resourceId ?? "*"}`;
}

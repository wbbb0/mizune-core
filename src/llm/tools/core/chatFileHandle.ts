import type { ChatFileKind } from "#types/chatContracts.ts";
import type { ChatFileRecord } from "#services/workspace/types.ts";
import type { BuiltinToolContext } from "./shared.ts";
import { mapWorkspaceFileToView, type WorkspaceFileView } from "./workspaceFileView.ts";
import { nextAction, withNextActions, type ToolNextAction } from "./toolNextActions.ts";

export type ChatFileHandleCapabilityName =
  | "view_media"
  | "inspect_media"
  | "send_to_chat";

export interface ChatFileHandleCapability {
  capability: ChatFileHandleCapabilityName;
  tool: string;
  reason: string;
  available: boolean;
  args: Record<string, string | number | boolean | string[]>;
  requires?: string[];
}

export interface ChatFileHandleOptions {
  visibleToolNames?: Iterable<string> | undefined;
  nextActionMode?: "default" | "none";
}

export type ChatFileHandleResult = WorkspaceFileView & {
  handle_capabilities: ChatFileHandleCapability[];
  next_actions?: ToolNextAction[];
};

const DEFAULT_VISIBLE_FILE_TOOLS = new Set([
  "chat_file_view_media",
  "chat_file_inspect_media",
  "chat_file_send_to_chat"
]);

const MEDIA_VIEW_KINDS = new Set<ChatFileKind>([
  "image",
  "animated_image",
  "video",
  "audio"
]);

const MEDIA_INSPECT_KINDS = new Set<ChatFileKind>([
  "image",
  "animated_image"
]);

export function buildChatFileHandleResult(
  file: ChatFileRecord,
  options: ChatFileHandleOptions = {}
): ChatFileHandleResult {
  const visibleToolNames = resolveVisibleToolNames(options.visibleToolNames);
  const capabilities = buildChatFileHandleCapabilities(file, visibleToolNames);
  const nextActions = options.nextActionMode === "none"
    ? []
    : buildChatFileHandleNextActions(file, capabilities);
  return withNextActions({
    ...mapWorkspaceFileToView(file),
    handle_capabilities: capabilities
  }, nextActions);
}

export function buildChatFileHandleResultFromContext(
  file: ChatFileRecord,
  context: BuiltinToolContext,
  options: Omit<ChatFileHandleOptions, "visibleToolNames"> = {}
): ChatFileHandleResult {
  return buildChatFileHandleResult(file, {
    ...options,
    visibleToolNames: context.debugSnapshot?.visibleToolNames
  });
}

export function buildChatFileHandleCapabilities(
  file: ChatFileRecord,
  visibleToolNamesInput?: Iterable<string> | undefined
): ChatFileHandleCapability[] {
  const visibleToolNames = resolveVisibleToolNames(visibleToolNamesInput);
  const selector = file.fileRef || file.fileId;
  const capabilities: ChatFileHandleCapability[] = [];

  if (MEDIA_VIEW_KINDS.has(file.kind)) {
    capabilities.push({
      capability: "view_media",
      tool: "chat_file_view_media",
      reason: "查看该媒体文件内容",
      available: visibleToolNames.has("chat_file_view_media"),
      args: { media_ids: [file.fileId] }
    });
  }

  if (MEDIA_INSPECT_KINDS.has(file.kind)) {
    capabilities.push({
      capability: "inspect_media",
      tool: "chat_file_inspect_media",
      reason: "按具体问题精读该图片内容",
      available: visibleToolNames.has("chat_file_inspect_media"),
      args: { media_ids: [file.fileId] },
      requires: ["question"]
    });
  }

  capabilities.push({
    capability: "send_to_chat",
    tool: "chat_file_send_to_chat",
    reason: "把该文件发送到当前聊天",
    available: visibleToolNames.has("chat_file_send_to_chat"),
    args: { file_ref: selector }
  });

  return capabilities;
}

function buildChatFileHandleNextActions(
  file: ChatFileRecord,
  capabilities: ChatFileHandleCapability[]
): ToolNextAction[] {
  const selector = file.fileRef || file.fileId;
  const actions: ToolNextAction[] = [];
  const viewMedia = capabilities.find((item) => item.capability === "view_media" && item.available);
  if (viewMedia) {
    actions.push(nextAction(viewMedia.tool, viewMedia.reason, viewMedia.args));
  }
  const send = capabilities.find((item) => item.capability === "send_to_chat" && item.available);
  if (send) {
    actions.push(nextAction(send.tool, send.reason, { file_ref: selector }));
  }
  return actions;
}

function resolveVisibleToolNames(input?: Iterable<string> | undefined): Set<string> {
  const names = input ? Array.from(input).filter(Boolean) : [];
  return names.length > 0 ? new Set(names) : DEFAULT_VISIBLE_FILE_TOOLS;
}

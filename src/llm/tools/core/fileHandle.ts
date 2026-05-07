import type { ChatFileKind, ChatFileRecord, LocalFileItemStat } from "#services/workspace/types.ts";
import { inferSendableFileKind } from "#services/workspace/sendablePath.ts";
import type { BuiltinToolContext } from "./shared.ts";
import { mapWorkspaceFileToView, type WorkspaceFileView } from "./workspaceFileView.ts";
import { nextAction, withNextActions, type ToolNextAction } from "./toolNextActions.ts";

export type ChatFileHandleCapabilityName =
  | "view_media"
  | "inspect_media"
  | "send_to_chat";

export type LocalFileHandleCapabilityName =
  | "read_text"
  | "view_media"
  | "inspect_media"
  | "send_to_chat";

export interface FileHandleCapability<Name extends string = string> {
  capability: Name;
  tool: string;
  reason: string;
  available: boolean;
  args: Record<string, string | number | boolean | string[]>;
  requires?: string[];
}

export type ChatFileHandleCapability = FileHandleCapability<ChatFileHandleCapabilityName>;
export type LocalFileHandleCapability = FileHandleCapability<LocalFileHandleCapabilityName>;

export interface ChatFileHandle {
  source: "chat_file";
  id: string;
  selector: {
    file_id: string;
    file_ref: string;
  };
  file: Pick<WorkspaceFileView, "file_id" | "file_ref" | "kind" | "chat_file_path" | "source_name" | "mime_type" | "size_bytes" | "origin">;
  capabilities: ChatFileHandleCapability[];
  next_actions?: ToolNextAction[];
}

export interface LocalFileHandle {
  source: "local_file";
  id: string;
  selector: {
    path: string;
  };
  file: {
    path: string;
    name: string;
    kind: LocalFileItemStat["kind"];
    media_kind: "image" | "animated_image" | "file";
    size_bytes: number;
    updated_at_ms: number;
  };
  capabilities: LocalFileHandleCapability[];
  next_actions?: ToolNextAction[];
}

export interface FileHandleOptions {
  visibleToolNames?: Iterable<string> | undefined;
  nextActionMode?: "default" | "none";
  defaultVisible?: boolean;
}

export type ChatFileHandleResult = WorkspaceFileView & {
  handle: ChatFileHandle;
  handle_capabilities: ChatFileHandleCapability[];
  next_actions?: ToolNextAction[];
};

export type LocalFileHandleResult = LocalFileItemStat & {
  handle: LocalFileHandle;
  handle_capabilities: LocalFileHandleCapability[];
  next_actions?: ToolNextAction[];
};

const DEFAULT_VISIBLE_CHAT_FILE_TOOLS = new Set([
  "chat_file_view_media",
  "chat_file_inspect_media",
  "chat_file_send_to_chat"
]);

const DEFAULT_VISIBLE_LOCAL_FILE_TOOLS = new Set([
  "local_file_read",
  "local_file_view_media",
  "local_file_inspect_media",
  "local_file_send_to_chat"
]);

const MEDIA_VIEW_KINDS = new Set<ChatFileKind>([
  "image",
  "animated_image"
]);

const MEDIA_INSPECT_KINDS = new Set<ChatFileKind>([
  "image",
  "animated_image"
]);

export function buildChatFileHandleResult(
  file: ChatFileRecord,
  options: FileHandleOptions = {}
): ChatFileHandleResult {
  const visibleToolNames = resolveVisibleToolNames(options.visibleToolNames, DEFAULT_VISIBLE_CHAT_FILE_TOOLS, options.defaultVisible ?? true);
  const capabilities = buildChatFileHandleCapabilities(file, visibleToolNames);
  const nextActions = options.nextActionMode === "none"
    ? []
    : buildChatFileHandleNextActions(file, capabilities);
  const view = mapWorkspaceFileToView(file);
  const handle = buildChatFileHandle(view, capabilities, nextActions);
  return withNextActions({
    ...view,
    handle,
    handle_capabilities: capabilities
  }, nextActions);
}

export function buildChatFileHandleResultFromContext(
  file: ChatFileRecord,
  context: BuiltinToolContext,
  options: Omit<FileHandleOptions, "visibleToolNames"> = {}
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
  const visibleToolNames = visibleToolNamesInput instanceof Set
    ? visibleToolNamesInput
    : resolveVisibleToolNames(visibleToolNamesInput, DEFAULT_VISIBLE_CHAT_FILE_TOOLS, true);
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

export function buildLocalFileHandleResult(
  file: LocalFileItemStat,
  options: FileHandleOptions = {}
): LocalFileHandleResult {
  const visibleToolNames = resolveVisibleToolNames(options.visibleToolNames, DEFAULT_VISIBLE_LOCAL_FILE_TOOLS, options.defaultVisible ?? true);
  const capabilities = buildLocalFileHandleCapabilities(file, visibleToolNames);
  const nextActions = options.nextActionMode === "none"
    ? []
    : buildLocalFileHandleNextActions(capabilities);
  const handle = buildLocalFileHandle(file, capabilities, nextActions);
  return withNextActions({
    ...file,
    handle,
    handle_capabilities: capabilities
  }, nextActions);
}

export function buildLocalFileHandleResultFromContext(
  file: LocalFileItemStat,
  context: BuiltinToolContext,
  options: Omit<FileHandleOptions, "visibleToolNames"> = {}
): LocalFileHandleResult {
  return buildLocalFileHandleResult(file, {
    ...options,
    visibleToolNames: context.debugSnapshot?.visibleToolNames
  });
}

export function buildLocalFileHandleCapabilities(
  file: LocalFileItemStat,
  visibleToolNamesInput?: Iterable<string> | undefined
): LocalFileHandleCapability[] {
  const visibleToolNames = visibleToolNamesInput instanceof Set
    ? visibleToolNamesInput
    : resolveVisibleToolNames(visibleToolNamesInput, DEFAULT_VISIBLE_LOCAL_FILE_TOOLS, true);
  const capabilities: LocalFileHandleCapability[] = [];
  const mediaKind = file.kind === "file" ? inferSendableFileKind(file.path || file.name) : "file";

  if (file.kind === "file") {
    capabilities.push({
      capability: "read_text",
      tool: "local_file_read",
      reason: "按文本读取该本地文件",
      available: visibleToolNames.has("local_file_read"),
      args: { path: file.path }
    });
  }

  if (file.kind === "file" && (mediaKind === "image" || mediaKind === "animated_image")) {
    capabilities.push({
      capability: "view_media",
      tool: "local_file_view_media",
      reason: "查看该本地图片内容",
      available: visibleToolNames.has("local_file_view_media"),
      args: { path: file.path }
    });
    capabilities.push({
      capability: "inspect_media",
      tool: "local_file_inspect_media",
      reason: "按具体问题精读该本地图片内容",
      available: visibleToolNames.has("local_file_inspect_media"),
      args: { path: file.path },
      requires: ["question"]
    });
  }

  if (file.kind === "file") {
    capabilities.push({
      capability: "send_to_chat",
      tool: "local_file_send_to_chat",
      reason: "把该本地文件发送到当前聊天",
      available: visibleToolNames.has("local_file_send_to_chat"),
      args: { path: file.path }
    });
  }

  return capabilities;
}

function buildChatFileHandle(
  file: WorkspaceFileView,
  capabilities: ChatFileHandleCapability[],
  nextActions: ToolNextAction[]
): ChatFileHandle {
  return withNextActions({
    source: "chat_file" as const,
    id: file.file_id,
    selector: {
      file_id: file.file_id,
      file_ref: file.file_ref
    },
    file: {
      file_id: file.file_id,
      file_ref: file.file_ref,
      kind: file.kind,
      chat_file_path: file.chat_file_path,
      source_name: file.source_name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      origin: file.origin
    },
    capabilities
  }, nextActions);
}

function buildLocalFileHandle(
  file: LocalFileItemStat,
  capabilities: LocalFileHandleCapability[],
  nextActions: ToolNextAction[]
): LocalFileHandle {
  return withNextActions({
    source: "local_file" as const,
    id: file.path,
    selector: { path: file.path },
    file: {
      path: file.path,
      name: file.name,
      kind: file.kind,
      media_kind: file.kind === "file" ? inferSendableFileKind(file.path || file.name) : "file",
      size_bytes: file.sizeBytes,
      updated_at_ms: file.updatedAtMs
    },
    capabilities
  }, nextActions);
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

function buildLocalFileHandleNextActions(
  capabilities: LocalFileHandleCapability[]
): ToolNextAction[] {
  const actions: ToolNextAction[] = [];
  const viewMedia = capabilities.find((item) => item.capability === "view_media" && item.available);
  if (viewMedia) {
    actions.push(nextAction(viewMedia.tool, viewMedia.reason, viewMedia.args));
  }
  const readText = capabilities.find((item) => item.capability === "read_text" && item.available);
  if (!viewMedia && readText) {
    actions.push(nextAction(readText.tool, readText.reason, readText.args));
  }
  const send = capabilities.find((item) => item.capability === "send_to_chat" && item.available);
  if (send) {
    actions.push(nextAction(send.tool, send.reason, send.args));
  }
  return actions;
}

function resolveVisibleToolNames(
  input: Iterable<string> | undefined,
  defaultNames: Set<string>,
  defaultVisible: boolean
): Set<string> {
  if (input !== undefined) {
    return new Set(Array.from(input).filter(Boolean));
  }
  return defaultVisible ? defaultNames : new Set();
}

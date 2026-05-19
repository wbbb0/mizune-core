import type { ChatFileKind, ChatFileRecord, LocalFileItemStat } from "#services/workspace/types.ts";
import { inferSendableFileKind } from "#services/workspace/sendablePath.ts";
import type { BuiltinToolContext } from "./shared.ts";
import { mapWorkspaceFileToView, type WorkspaceFileView } from "./workspaceFileView.ts";
import { nextAction, withNextActions, type ToolNextAction } from "./toolNextActions.ts";

export type AssetHandleCapabilityName =
  | "view_media"
  | "inspect_media"
  | "send_to_chat"
  | "local_path"
  | "export_to_filesystem"
  | "document_overview"
  | "document_search"
  | "document_read"
  | "document_inspect";

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

export interface FileHandleUsageHint {
  code: string;
  message: string;
}

export type AssetHandleCapability = FileHandleCapability<AssetHandleCapabilityName>;
export type LocalFileHandleCapability = FileHandleCapability<LocalFileHandleCapabilityName>;

export interface AssetHandle {
  source: "asset";
  id: string;
  asset_id: string;
  asset_ref: string;
  selector: {
    asset_id: string;
    asset_ref: string;
  };
  kind: WorkspaceFileView["kind"];
  origin: WorkspaceFileView["origin"];
  source_name: string;
  mime_type: string;
  size_bytes: number;
  created_at_ms: number;
  caption: string | null;
  caption_status: WorkspaceFileView["caption_status"];
  capabilities: AssetHandleCapability[];
  usage_hints: FileHandleUsageHint[];
  next_actions?: ToolNextAction[];
}

export interface LocalFileHandle {
  source: "filesystem";
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
  asset_handle: AssetHandle;
  next_actions?: ToolNextAction[];
};

export type LocalFileHandleResult = LocalFileItemStat & {
  handle: LocalFileHandle;
  handle_capabilities: LocalFileHandleCapability[];
  next_actions?: ToolNextAction[];
};

const DEFAULT_VISIBLE_CHAT_FILE_TOOLS = new Set([
  "asset_media_view",
  "asset_media_inspect",
  "asset_send_to_chat",
  "asset_local_path",
  "asset_export_to_filesystem",
  "asset_document_overview",
  "asset_document_read",
  "asset_document_search"
]);

const DEFAULT_VISIBLE_LOCAL_FILE_TOOLS = new Set([
  "filesystem_read",
  "filesystem_media_view",
  "filesystem_media_inspect",
  "filesystem_send_to_chat"
]);

const MEDIA_VIEW_KINDS = new Set<ChatFileKind>([
  "image",
  "animated_image"
]);

const MEDIA_INSPECT_KINDS = new Set<ChatFileKind>([
  "image",
  "animated_image"
]);

const DOCUMENT_MIME_PREFIXES = [
  "text/",
  "application/pdf"
];

const DOCUMENT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "text/markdown"
]);

const DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".docx",
  ".json",
  ".md",
  ".pdf",
  ".txt",
  ".xls",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml"
]);

const ASSET_INTERNAL_PATH_HINT: FileHandleUsageHint = {
  code: "asset_internal_path",
  message: "chat_file_path 是 asset store 内部路径；需要副本时用 asset_export_to_filesystem。"
};

export function assetInternalPathUsageHints(): FileHandleUsageHint[] {
  return [ASSET_INTERNAL_PATH_HINT];
}

export function buildChatFileHandleResult(
  file: ChatFileRecord,
  options: FileHandleOptions = {}
): ChatFileHandleResult {
  const visibleToolNames = resolveVisibleToolNames(options.visibleToolNames, DEFAULT_VISIBLE_CHAT_FILE_TOOLS, options.defaultVisible ?? true);
  const view = mapWorkspaceFileToView(file);
  const assetHandle = buildAssetHandle(view, visibleToolNames);
  const nextActions = options.nextActionMode === "none"
    ? []
    : assetHandle.next_actions ?? [];
  return withNextActions({
    ...view,
    asset_handle: assetHandle
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
      tool: "filesystem_read",
      reason: "按文本读取该本地文件",
      available: visibleToolNames.has("filesystem_read"),
      args: { path: file.path }
    });
  }

  if (file.kind === "file" && (mediaKind === "image" || mediaKind === "animated_image")) {
    capabilities.push({
      capability: "view_media",
      tool: "filesystem_media_view",
      reason: "查看该本地图片内容",
      available: visibleToolNames.has("filesystem_media_view"),
      args: { path: file.path }
    });
    capabilities.push({
      capability: "inspect_media",
      tool: "filesystem_media_inspect",
      reason: "按具体问题精读该本地图片内容",
      available: visibleToolNames.has("filesystem_media_inspect"),
      args: { path: file.path },
      requires: ["question"]
    });
  }

  if (file.kind === "file") {
    capabilities.push({
      capability: "send_to_chat",
      tool: "filesystem_send_to_chat",
      reason: "把该本地文件发送到当前聊天",
      available: visibleToolNames.has("filesystem_send_to_chat"),
      args: { path: file.path },
      ...(mediaKind === "image" || mediaKind === "animated_image" ? {} : { requires: ["webui_or_napcat_file_upload"] })
    });
  }

  return capabilities;
}

function buildAssetHandle(
  file: WorkspaceFileView,
  visibleToolNames: Set<string>
): AssetHandle {
  const assetCapabilities = buildAssetFileCapabilities(file, visibleToolNames);
  if (isDocumentAsset(file)) {
    assetCapabilities.push(...buildDocumentAssetCapabilities(file, visibleToolNames));
  }
  const nextActions = buildAssetHandleNextActions(assetCapabilities);
  return withNextActions({
    source: "asset" as const,
    id: file.file_id,
    asset_id: file.file_id,
    asset_ref: file.file_ref,
    selector: {
      asset_id: file.file_id,
      asset_ref: file.file_ref
    },
    kind: file.kind,
    origin: file.origin,
    source_name: file.source_name,
    mime_type: file.mime_type,
    size_bytes: file.size_bytes,
    created_at_ms: file.created_at_ms,
    caption: file.caption,
    caption_status: file.caption_status,
    capabilities: assetCapabilities,
    usage_hints: assetInternalPathUsageHints()
  }, nextActions);
}

function buildAssetFileCapabilities(
  file: WorkspaceFileView,
  visibleToolNames: Set<string>
): AssetHandleCapability[] {
  const selector = { asset_ref: file.file_ref };
  const capabilities: AssetHandleCapability[] = [];
  if (MEDIA_VIEW_KINDS.has(file.kind)) {
    capabilities.push({
      capability: "view_media",
      tool: "asset_media_view",
      reason: "查看该媒体 asset 内容",
      available: visibleToolNames.has("asset_media_view"),
      args: selector
    });
  }

  if (MEDIA_INSPECT_KINDS.has(file.kind)) {
    capabilities.push({
      capability: "inspect_media",
      tool: "asset_media_inspect",
      reason: "按具体问题精读该图片 asset 内容",
      available: visibleToolNames.has("asset_media_inspect"),
      args: selector,
      requires: ["question"]
    });
  }

  capabilities.push({
    capability: "send_to_chat",
    tool: "asset_send_to_chat",
    reason: "把该 asset 发送到当前聊天",
    available: visibleToolNames.has("asset_send_to_chat"),
    args: selector,
    ...(MEDIA_VIEW_KINDS.has(file.kind) ? {} : { requires: ["webui_or_napcat_file_upload"] })
  });
  capabilities.push({
    capability: "local_path",
    tool: "asset_local_path",
    reason: "获取该 asset 对应的本地路径",
    available: visibleToolNames.has("asset_local_path"),
    args: selector
  });
  capabilities.push({
    capability: "export_to_filesystem",
    tool: "asset_export_to_filesystem",
    reason: "复制该 asset 到指定本地路径",
    available: visibleToolNames.has("asset_export_to_filesystem"),
    args: selector,
    requires: ["to_path"]
  });
  return capabilities;
}

function buildDocumentAssetCapabilities(
  file: WorkspaceFileView,
  visibleToolNames: Set<string>
): AssetHandleCapability[] {
  const selector = { asset_ref: file.file_ref };
  return [
    {
      capability: "document_overview",
      tool: "asset_document_overview",
      reason: "查看该文档的摘要、目录和可读状态",
      available: visibleToolNames.has("asset_document_overview"),
      args: selector
    },
    {
      capability: "document_read",
      tool: "asset_document_read",
      reason: "按行段读取该文档的正文",
      available: visibleToolNames.has("asset_document_read"),
      args: selector,
      requires: ["start_line"]
    },
    {
      capability: "document_search",
      tool: "asset_document_search",
      reason: "在该文档内搜索关键词",
      available: visibleToolNames.has("asset_document_search"),
      args: selector,
      requires: ["query"]
    },
    {
      capability: "document_inspect",
      tool: "asset_document_inspect",
      reason: "调用文本精读模型总结或回答文档问题",
      available: visibleToolNames.has("asset_document_inspect"),
      args: selector,
      requires: ["question"]
    }
  ];
}

function isDocumentAsset(file: WorkspaceFileView): boolean {
  if (file.kind !== "file") {
    return false;
  }
  const mimeType = file.mime_type.toLowerCase();
  if (DOCUMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || DOCUMENT_MIME_TYPES.has(mimeType)) {
    return true;
  }
  const names = [file.source_name, file.file_ref, file.chat_file_path].map((item) => item.toLowerCase());
  return names.some((name) => Array.from(DOCUMENT_EXTENSIONS).some((ext) => name.endsWith(ext)));
}

function buildLocalFileHandle(
  file: LocalFileItemStat,
  capabilities: LocalFileHandleCapability[],
  nextActions: ToolNextAction[]
): LocalFileHandle {
  return withNextActions({
    source: "filesystem" as const,
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

function buildAssetHandleNextActions(
  capabilities: AssetHandleCapability[]
): ToolNextAction[] {
  const actions: ToolNextAction[] = [];
  const viewMedia = capabilities.find((item) => item.capability === "view_media" && item.available);
  if (viewMedia) {
    actions.push(nextAction(viewMedia.tool, viewMedia.reason, viewMedia.args));
  }
  const send = capabilities.find((item) => item.capability === "send_to_chat" && item.available);
  if (send) {
    actions.push(nextAction(send.tool, send.reason, send.args));
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

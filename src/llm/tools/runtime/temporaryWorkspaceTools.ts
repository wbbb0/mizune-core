import { cloneWorkspaceRepository, extractWorkspaceZip, packWorkspaceZip } from "#services/workspace/workspaceFileOperations.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { workspaceActor } from "../core/filesystemScope.ts";
import { buildChatFileHandleResultFromContext } from "../core/fileHandle.ts";

export const temporaryWorkspaceToolDescriptors: ToolDescriptor[] = [
  ...[
    { name: "workspace_clone", description: "获取公开 HTTPS Git 仓库的最新浅克隆文件到新子目录，不执行代码，不保留 Git 历史，不下载子模块。地址应使用最终 URL，不支持重定向。", fields: { url: { type: "string" }, to_path: { type: "string" } }, required: ["url", "to_path"] },
    { name: "workspace_extract", description: "解压工作区中的 ZIP 到新的子目录；不允许越界路径、链接或特殊文件，展开最多 256 MiB。", fields: { path: { type: "string" }, to_path: { type: "string" } }, required: ["path", "to_path"] },
    { name: "workspace_pack", description: "将工作区内的文件或目录打包为新的 ZIP 文件，路径均相对于工作区。之后可用 workspace_export 或 filesystem_send_to_chat。", fields: { paths: { type: "array", items: { type: "string" }, minItems: 1 }, to_path: { type: "string" } }, required: ["paths", "to_path"] }
  ].map((tool): ToolDescriptor => ({ definition: { type: "function", function: {
    name: tool.name, description: tool.description,
    parameters: { type: "object", properties: { workspace_id: { type: "string" }, ...tool.fields }, required: ["workspace_id", ...tool.required], additionalProperties: false }
  } }, isEnabled: (config) => config.localFiles.enabled })),
  {
    definition: { type: "function", function: {
      name: "workspace_create", description: "没有明确目标路径或需要处理临时文件时，创建工作区。固定保留一天，重启仍可用。后续 filesystem 工具和 asset_export_to_filesystem 都传 workspace_id 和相对路径。网络、消息、群文件先用现有下载工具取得 asset，再复制进工作区。",
      parameters: { type: "object", properties: { name: { type: "string", description: "简短任务名称" } }, additionalProperties: false }
    } }, isEnabled: (config) => config.localFiles.enabled
  },
  {
    definition: { type: "function", function: {
      name: "workspace_close", description: "关闭当前用户的临时工作区并删除其中所有文件；已导出的 asset 保留。",
      parameters: { type: "object", properties: { workspace_id: { type: "string" } }, required: ["workspace_id"], additionalProperties: false }
    } }, isEnabled: (config) => config.localFiles.enabled
  },
  {
    definition: { type: "function", function: {
      name: "workspace_export", description: "把工作区中的一个文件复制登记为持久 asset，用于之后发送或处理。原文件不变。",
      parameters: { type: "object", properties: { workspace_id: { type: "string" }, path: { type: "string", description: "工作区内相对文件路径" } }, required: ["workspace_id", "path"], additionalProperties: false }
    } }, isEnabled: (config) => config.localFiles.enabled && config.chatFiles.enabled
  }
];

export const temporaryWorkspaceToolHandlers: Record<string, ToolHandler> = {
  ...Object.fromEntries(["workspace_clone", "workspace_extract", "workspace_pack"].map((name): [string, ToolHandler] => [name, async (_call, args, context) => {
    const id = getStringArg(args, "workspace_id");
    const toPath = getStringArg(args, "to_path");
    if (!id || !toPath) throw new Error("workspace_id 和 to_path 必填");
    return context.temporaryWorkspaceService.withFiles(id, workspaceActor(context), async (files, record) => {
      if (name === "workspace_clone") {
        const url = getStringArg(args, "url");
        if (!url) throw new Error("url 必填");
        await cloneWorkspaceRepository(files, url, toPath, record.expiresAtMs);
      } else if (name === "workspace_extract") {
        const path = getStringArg(args, "path");
        if (!path) throw new Error("path 必填");
        await extractWorkspaceZip(files, path, toPath);
      } else {
        const paths = args && typeof args === "object" && "paths" in args ? args.paths : null;
        if (!Array.isArray(paths) || !paths.length || !paths.every((path): path is string => typeof path === "string" && !!path)) throw new Error("paths 必须为非空路径列表");
        await packWorkspaceZip(files, paths, toPath);
      }
      return JSON.stringify({ ok: true, workspace_id: id, path: toPath });
    });
  }])),
  async workspace_create(_call, args, context) {
    const workspace = await context.temporaryWorkspaceService.create(workspaceActor(context), getStringArg(args, "name") ?? undefined);
    return JSON.stringify({ ...workspace, workspace_id: workspace.resource_id, next_actions: [{ tool: "filesystem_list", reason: "查看工作区", args: { workspace_id: workspace.resource_id, path: "." } }] });
  },
  async workspace_close(_call, args, context) {
    const id = getStringArg(args, "workspace_id");
    if (!id) throw new Error("workspace_id 必填");
    await context.temporaryWorkspaceService.close(id, workspaceActor(context));
    return JSON.stringify({ ok: true, workspace_id: id });
  },
  async workspace_export(_call, args, context) {
    const id = getStringArg(args, "workspace_id");
    const path = getStringArg(args, "path");
    if (!id || !path) throw new Error("workspace_id 和 path 必填");
    return context.temporaryWorkspaceService.withFiles(id, workspaceActor(context), async (files) => {
      const source = files.resolvePath(path);
      const file = await context.chatFileStore.importFileFromPath({ sourcePath: source.absolutePath, origin: "local_file_import", sourceContext: { sessionId: context.lastMessage.sessionId, workspaceId: id } });
      return JSON.stringify({ ok: true, workspace_id: id, ...buildChatFileHandleResultFromContext(file, context) });
    });
  }
};

import type { ToolResultObservationPolicy } from "./resultObservation.ts";
import type { BuiltinToolContext, ToolDescriptor, ToolHandler } from "./shared.ts";
import { getStringArg } from "./toolArgHelpers.ts";
import type { WorkspaceActor } from "#services/workspace/temporaryWorkspaceService.ts";

export function workspaceActor(context: BuiltinToolContext): WorkspaceActor {
  return { sessionId: context.lastMessage.sessionId, userId: context.lastMessage.userId };
}

export function supportsWorkspace(name: string): boolean {
  return name.startsWith("filesystem_") || name === "asset_export_to_filesystem";
}

export function withFilesystemScopeDescriptors(descriptors: ToolDescriptor[]): ToolDescriptor[] {
  return descriptors.map((descriptor) => {
    const fn = descriptor.definition.function;
    if (!supportsWorkspace(fn.name)) return descriptor;
    return { ...descriptor, ...(descriptor.resultObservation ? { resultObservation: scopeObservation(descriptor.resultObservation) } : {}), definition: { ...descriptor.definition, function: {
      ...fn,
      description: `${fn.description} 可选 workspace_id：传入时路径仅相对于该工作区；不传时沿用本地路径规则。无明确目标位置或临时文件任务先用 workspace_create。`,
      parameters: { ...fn.parameters, properties: {
        ...(fn.parameters as { properties?: Record<string, unknown> }).properties,
        workspace_id: { type: "string", minLength: 1, description: "临时工作区 ID；传入后所有路径必须为工作区内相对路径" }
      } }
    } } };
  });
}

export function withFilesystemScopeHandlers(handlers: Record<string, ToolHandler>): Record<string, ToolHandler> {
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, !supportsWorkspace(name) ? handler : async (call, args, context) => {
    const id = getStringArg(args, "workspace_id");
    if (!id) {
      if (args && typeof args === "object" && "workspace_id" in args) throw new Error("workspace_id 不能为空");
      return handler(call, args, context);
    }
    return context.temporaryWorkspaceService.withFiles(id, workspaceActor(context), async (files) => {
      const result = await handler(call, args, { ...context, localFileService: files });
      if (typeof result === "string") return scopeContent(result, id);
      const content = scopeContent(result.content, id);
      return {
        ...result,
        content,
        ...(result.canonicalContent ? { canonicalContent: scopeContent(result.canonicalContent, id) } : {}),
        toString() { return content; }
      };
    });
  }]));
}

function scopeContent(content: string, id: string): string {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return content; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return content;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.tool === "string" && supportsWorkspace(record.tool) && record.args && typeof record.args === "object") {
      Object.assign(record.args, { workspace_id: id });
    }
    if (record.source === "filesystem" && record.selector && typeof record.selector === "object") {
      Object.assign(record.selector, { workspace_id: id });
      if (!String(record.id ?? "").startsWith(`${id}:`)) record.id = `${id}:${String(record.id ?? "")}`;
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return JSON.stringify({ ...value, workspace_id: id });
}

function scopeObservation(policy: ToolResultObservationPolicy): ToolResultObservationPolicy {
  const workspaceId = (args: Record<string, unknown>) => typeof args.workspace_id === "string" ? args.workspace_id : null;
  return {
    ...policy,
    resource(ctx) {
      const resource = policy.resource?.(ctx) ?? null;
      const id = workspaceId(ctx.args);
      return resource && id ? { ...resource, id: `${id}:${resource.id}`, locator: resource.id } : resource;
    },
    refetchHint(ctx) {
      const id = workspaceId(ctx.args);
      const hint = policy.refetchHint?.(id && ctx.resource?.locator ? { ...ctx, resource: { ...ctx.resource, id: ctx.resource.locator } } : ctx) ?? null;
      return hint && id ? `${hint} workspace_id=${JSON.stringify(id)}` : hint;
    },
    ...(policy.compactors ? { compactors: Object.fromEntries(Object.entries(policy.compactors).map(([name, compact]) => [name, (ctx) => {
      const result = compact(ctx);
      const id = workspaceId(ctx.args);
      return id ? { ...result, replayContent: scopeContent(result.replayContent, id), summary: `${result.summary}（工作区 ${id}）` } : result;
    }])) } : {})
  };
}

import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";
import { findBestDuplicateMatch } from "#memory/similarity.ts";

export const profileToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "read_memory",
        description: "读取长期记忆或 persona。scope=global 读取全局记忆（仅 owner）；scope=user 读取用户记忆（默认当前触发用户）；scope=persona 读取当前 persona。",
        parameters: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["global", "user", "persona"]
            },
            user_id: { type: "string" }
          },
          required: ["scope"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "write_memory",
        description: "写入长期记忆或 persona。scope=global|user 时写 memory（可传 memoryId 更新）；scope=persona 时写入 personaPatch。",
        parameters: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["global", "user", "persona"]
            },
            user_id: { type: "string" },
            memoryId: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            personaPatch: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string" },
                appearance: { type: "string" },
                personality: { type: "string" },
                interests: { type: "string" },
                background: { type: "string" },
                speechStyle: { type: "string" },
                rules: { type: "string" }
              },
              additionalProperties: false
            }
          },
          required: ["scope"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "remove_memory",
        description: "删除长期记忆，或清空 persona 字段。scope=global|user 时需 memoryId；scope=persona 时需 personaField。",
        parameters: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["global", "user", "persona"]
            },
            user_id: { type: "string" },
            memoryId: { type: "string" },
            personaField: {
              type: "string",
              enum: [
                "name",
                "role",
                "appearance",
                "personality",
                "interests",
                "background",
                "speechStyle",
                "rules"
              ]
            }
          },
          required: ["scope"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "list_operation_notes",
        description: "读取 operation notes。可按 toolset_ids 过滤。写入前优先先读，避免重复。",
        parameters: {
          type: "object",
          properties: {
            toolset_ids: {
              type: "array",
              items: { type: "string" }
            }
          },
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "write_operation_note",
        description: "写入工具集绑定的长期操作笔记。必须提供 title、content、toolset_ids。写入前应先读取现有 notes；若已有相近内容，优先更新，严禁创建重复内容。",
        parameters: {
          type: "object",
          properties: {
            noteId: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            toolset_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1
            }
          },
          required: ["title", "content", "toolset_ids"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "remove_operation_note",
        description: "删除一条 operation note，需要 noteId。",
        parameters: {
          type: "object",
          properties: {
            noteId: { type: "string" }
          },
          required: ["noteId"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "get_user_profile",
        description: "读取当前用户已存的长期 profile 和 memories。主动写入前优先先读，避免重复或冲突。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "register_known_user",
        description: "为其他用户创建或更新已存 profile，用于长期资料管理。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            preferredAddress: { type: "string" },
            gender: { type: "string" },
            residence: { type: "string" },
            profileSummary: { type: "string" },
            relationshipNote: { type: "string" }
          },
          required: ["user_id"],
          additionalProperties: false
        }
      }
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "set_user_special_role",
        description: "设置用户的特殊角色。npc 表示需要保留在 prompt 上下文里的协作 bot 用户。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            specialRole: {
              type: "string",
              enum: ["none", "npc"]
            }
          },
          required: ["user_id", "specialRole"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "remember_user_profile",
        description: "为用户写入结构化长期 profile 字段，适合稳定且以后还会用到的自我信息。优先先看已存数据，避免重复或冲突。preferredAddress=称呼，profileSummary=用户画像，relationshipNote=与用户的关系背景（仅 owner 可写）。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            preferredAddress: { type: "string" },
            gender: { type: "string" },
            residence: { type: "string" },
            profileSummary: { type: "string" },
            relationshipNote: { type: "string" }
          },
          additionalProperties: false
        }
      }
    }
  }
];

function getStringField(args: unknown, key: string): string {
  return typeof args === "object" && args && key in args
    ? String((args as Record<string, unknown>)[key] ?? "").trim()
    : "";
}

function resolveTargetUserId(args: unknown, fallbackUserId: string): string {
  return getStringField(args, "user_id") || fallbackUserId;
}

function getStringArrayField(args: unknown, key: string): string[] {
  if (typeof args !== "object" || !args || !(key in args) || !Array.isArray((args as Record<string, unknown>)[key])) {
    return [];
  }
  return ((args as Record<string, unknown>)[key] as unknown[])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function requireOwnerOrSelf(
  context: Parameters<ToolHandler>[2],
  targetUserId: string,
  error: string
): string | null {
  if (context.relationship === "owner" || targetUserId === context.lastMessage.userId) {
    return null;
  }
  return JSON.stringify({ error });
}

function parseUserProfilePatch(args: unknown): {
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  profileSummary?: string;
  relationshipNote?: string;
} {
  return {
    ...(typeof args === "object" && args && "preferredAddress" in args
      ? { preferredAddress: String((args as { preferredAddress: unknown }).preferredAddress) }
      : {}),
    ...(typeof args === "object" && args && "gender" in args
      ? { gender: String((args as { gender: unknown }).gender) }
      : {}),
    ...(typeof args === "object" && args && "residence" in args
      ? { residence: String((args as { residence: unknown }).residence) }
      : {}),
    ...(typeof args === "object" && args && "profileSummary" in args
      ? { profileSummary: String((args as { profileSummary: unknown }).profileSummary) }
      : {}),
    ...(typeof args === "object" && args && "relationshipNote" in args
      ? { relationshipNote: String((args as { relationshipNote: unknown }).relationshipNote) }
      : {})
  };
}

export const profileToolHandlers: Record<string, ToolHandler> = {
  async list_operation_notes(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can inspect operation notes");
    if (denied) {
      return denied;
    }
    const toolsetIds = new Set(getStringArrayField(args, "toolset_ids"));
    const notes = await context.operationNoteStore.getAll();
    return JSON.stringify(
      toolsetIds.size > 0
        ? notes.filter((item) => item.toolsetIds.some((id) => toolsetIds.has(id)))
        : notes
    );
  },
  async get_user_profile(_toolCall, _args, context) {
    return JSON.stringify({
      user_id: context.lastMessage.userId,
      senderName: context.lastMessage.senderName,
      relationship: context.currentUser?.relationship ?? null,
      specialRole: context.currentUser?.specialRole ?? null,
      preferredAddress: context.currentUser?.preferredAddress ?? null,
      gender: context.currentUser?.gender ?? null,
      residence: context.currentUser?.residence ?? null,
      profileSummary: context.currentUser?.profileSummary ?? null,
      relationshipNote: context.currentUser?.relationshipNote ?? null,
      memories: context.currentUser?.memories ?? []
    });
  },
  async read_memory(_toolCall, args, context) {
    const scope = getStringField(args, "scope");
    if (scope === "global") {
      const denied = requireOwner(context.relationship, "Only owner can inspect global memories");
      if (denied) {
        return denied;
      }
      return JSON.stringify(await context.globalMemoryStore.getAll());
    }
    if (scope === "user") {
      const userId = resolveTargetUserId(args, context.lastMessage.userId);
      const denied = requireOwnerOrSelf(context, userId, "Only owner can inspect another user's memories");
      if (denied) {
        return denied;
      }
      const user = await context.userStore.getByUserId(userId);
      return JSON.stringify(user?.memories ?? []);
    }
    if (scope === "persona") {
      return JSON.stringify(await context.personaStore.get());
    }
    return JSON.stringify({ error: "scope must be global, user, or persona" });
  },
  async write_memory(_toolCall, args, context) {
    const scope = getStringField(args, "scope");
    if (scope === "global") {
      const denied = requireOwner(context.relationship, "Only owner can edit global memories");
      if (denied) {
        return denied;
      }
      const title = getStringField(args, "title");
      const content = getStringField(args, "content");
      if (!title || !content) {
        return JSON.stringify({ error: "title and content are required" });
      }
      return JSON.stringify(await context.globalMemoryStore.upsert({
        ...(getStringField(args, "memoryId") ? { memoryId: getStringField(args, "memoryId") } : {}),
        title,
        content
      }));
    }
    if (scope === "user") {
      const userId = resolveTargetUserId(args, context.lastMessage.userId);
      const denied = requireOwnerOrSelf(context, userId, "Only owner can edit another user's memories");
      if (denied) {
        return denied;
      }
      const title = getStringField(args, "title");
      const content = getStringField(args, "content");
      if (!title || !content) {
        return JSON.stringify({ error: "title and content are required" });
      }
      const updated = await context.userStore.upsertMemory({
        userId,
        ...(getStringField(args, "memoryId") ? { memoryId: getStringField(args, "memoryId") } : {}),
        title,
        content
      });
      return JSON.stringify(updated.memories);
    }
    if (scope === "persona") {
      const denied = requireOwner(context.relationship, "Only owner can update persona");
      if (denied) {
        return denied;
      }
      const personaPatch = typeof args === "object" && args && "personaPatch" in args && typeof (args as { personaPatch?: unknown }).personaPatch === "object"
        ? Object.fromEntries(
            Object.entries((args as { personaPatch: Record<string, unknown> }).personaPatch)
              .filter(([, value]) => typeof value === "string")
          )
        : {};
      if (Object.keys(personaPatch).length === 0) {
        return JSON.stringify({ error: "personaPatch with at least one string field is required" });
      }
      const updated = await context.personaStore.patch(personaPatch);
      await context.setupStore.advanceAfterPersonaUpdate(updated);
      return JSON.stringify(updated);
    }
    return JSON.stringify({ error: "scope must be global, user, or persona" });
  },
  async write_operation_note(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can edit operation notes");
    if (denied) {
      return denied;
    }
    const title = getStringField(args, "title");
    const content = getStringField(args, "content");
    const toolsetIds = getStringArrayField(args, "toolset_ids");
    const noteId = getStringField(args, "noteId");
    if (!title || !content || toolsetIds.length === 0) {
      return JSON.stringify({ error: "title, content and toolset_ids are required" });
    }
    const notes = await context.operationNoteStore.getAll();
    const duplicate = findBestDuplicateMatch(
      `${title} ${content} ${toolsetIds.join(" ")}`,
      notes.filter((item) => !noteId || item.id !== noteId),
      (item) => `${item.title} ${item.content} ${item.toolsetIds.join(" ")}`
    );
    if (duplicate && !noteId) {
      return JSON.stringify({
        error: "duplicate_operation_note",
        message: "Found similar existing operation note; update it instead of creating a duplicate",
        existing: duplicate
      });
    }
    return JSON.stringify(await context.operationNoteStore.upsert({
      ...(noteId ? { noteId } : duplicate?.id ? { noteId: duplicate.id } : {}),
      title,
      content,
      toolsetIds,
      source: "model"
    }));
  },
  async remove_memory(_toolCall, args, context) {
    const scope = getStringField(args, "scope");
    if (scope === "global") {
      const denied = requireOwner(context.relationship, "Only owner can edit global memories");
      if (denied) {
        return denied;
      }
      const memoryId = getStringField(args, "memoryId");
      if (!memoryId) {
        return JSON.stringify({ error: "memoryId is required" });
      }
      return JSON.stringify(await context.globalMemoryStore.remove(memoryId));
    }
    if (scope === "user") {
      const userId = resolveTargetUserId(args, context.lastMessage.userId);
      const denied = requireOwnerOrSelf(context, userId, "Only owner can edit another user's memories");
      if (denied) {
        return denied;
      }
      const memoryId = getStringField(args, "memoryId");
      if (!memoryId) {
        return JSON.stringify({ error: "memoryId is required" });
      }
      const updated = await context.userStore.removeMemory(userId, memoryId);
      if (!updated) {
        return JSON.stringify({ error: "User not found" });
      }
      return JSON.stringify(updated.memories);
    }
    if (scope === "persona") {
      const denied = requireOwner(context.relationship, "Only owner can update persona");
      if (denied) {
        return denied;
      }
      const personaField = getStringField(args, "personaField");
      if (!personaField) {
        return JSON.stringify({ error: "personaField is required" });
      }
      const updated = await context.personaStore.patch({ [personaField]: "" });
      await context.setupStore.advanceAfterPersonaUpdate(updated);
      return JSON.stringify(updated);
    }
    return JSON.stringify({ error: "scope must be global, user, or persona" });
  },
  async remove_operation_note(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can edit operation notes");
    if (denied) {
      return denied;
    }
    const noteId = getStringField(args, "noteId");
    if (!noteId) {
      return JSON.stringify({ error: "noteId is required" });
    }
    return JSON.stringify(await context.operationNoteStore.remove(noteId));
  },
  async register_known_user(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can register known users");
    if (denied) {
      return denied;
    }
    const userId = getStringField(args, "user_id");
    if (!userId) {
      return JSON.stringify({ error: "user_id is required" });
    }
    const updated = await context.userStore.registerKnownUser({
      userId,
      ...parseUserProfilePatch(args)
    });
    return JSON.stringify(updated);
  },
  async remember_user_profile(_toolCall, args, context) {
    const userId = resolveTargetUserId(args, context.lastMessage.userId);
    const denied = requireOwnerOrSelf(context, userId, "Only owner can edit another user's profile");
    if (denied) {
      return denied;
    }
    if (context.relationship !== "owner" && typeof args === "object" && args && "relationshipNote" in args) {
      return JSON.stringify({ error: "Only owner can edit relationshipNote" });
    }
    const patch = parseUserProfilePatch(args);
    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ error: "At least one user profile field is required" });
    }
    const updated = await context.userStore.patchUserProfile({
      userId,
      ...patch
    });
    return JSON.stringify(updated);
  },
  async set_user_special_role(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can set special user roles");
    if (denied) {
      return denied;
    }
    const userId = getStringField(args, "user_id");
    const specialRole = getStringField(args, "specialRole");
    if (!userId || !["none", "npc"].includes(specialRole)) {
      return JSON.stringify({ error: "Invalid user_id or specialRole" });
    }
    const updated = await context.userStore.setSpecialRole(userId, specialRole as "npc" | "none");
    await context.npcDirectory.refresh(context.userStore);
    return JSON.stringify(updated);
  }
};

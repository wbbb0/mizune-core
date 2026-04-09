import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";

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
                identity: { type: "string" },
                virtualAppearance: { type: "string" },
                personality: { type: "string" },
                hobbies: { type: "string" },
                likesAndDislikes: { type: "string" },
                familyBackground: { type: "string" },
                speakingStyle: { type: "string" },
                secrets: { type: "string" },
                residence: { type: "string" },
                roleplayRequirements: { type: "string" }
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
                "identity",
                "virtualAppearance",
                "personality",
                "hobbies",
                "likesAndDislikes",
                "familyBackground",
                "speakingStyle",
                "secrets",
                "residence",
                "roleplayRequirements"
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
            nickname: { type: "string" },
            preferredAddress: { type: "string" },
            gender: { type: "string" },
            residence: { type: "string" },
            profileSummary: { type: "string" },
            sharedContext: { type: "string" }
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
        description: "为用户写入结构化长期 profile 字段，适合稳定且以后还会用到的自我信息。优先先看已存数据，避免重复或冲突。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            nickname: { type: "string" },
            preferredAddress: { type: "string" },
            gender: { type: "string" },
            residence: { type: "string" },
            profileSummary: { type: "string" },
            sharedContext: { type: "string" }
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
  nickname?: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  profileSummary?: string;
  sharedContext?: string;
} {
  return {
    ...(typeof args === "object" && args && "nickname" in args
      ? { nickname: String((args as { nickname: unknown }).nickname) }
      : {}),
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
    ...(typeof args === "object" && args && "sharedContext" in args
      ? { sharedContext: String((args as { sharedContext: unknown }).sharedContext) }
      : {})
  };
}

export const profileToolHandlers: Record<string, ToolHandler> = {
  async get_user_profile(_toolCall, _args, context) {
    return JSON.stringify({
      user_id: context.lastMessage.userId,
      senderName: context.lastMessage.senderName,
      nickname: context.currentUser?.nickname ?? null,
      relationship: context.currentUser?.relationship ?? null,
      specialRole: context.currentUser?.specialRole ?? "none",
      preferredAddress: context.currentUser?.preferredAddress ?? null,
      gender: context.currentUser?.gender ?? null,
      residence: context.currentUser?.residence ?? null,
      profileSummary: context.currentUser?.profileSummary ?? null,
      sharedContext: context.currentUser?.sharedContext ?? null,
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
    if (context.relationship !== "owner" && typeof args === "object" && args && "sharedContext" in args) {
      return JSON.stringify({ error: "Only owner can edit sharedContext that describes shared background or cross-user context" });
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
    const updated = await context.userStore.setSpecialRole(userId, specialRole as "none" | "npc");
    await context.npcDirectory.refresh(context.userStore);
    return JSON.stringify(updated);
  }
};

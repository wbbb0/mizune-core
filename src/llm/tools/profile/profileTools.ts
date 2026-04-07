import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";

export const profileToolDescriptors: ToolDescriptor[] = [
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "get_global_memories",
        description: "读取当前长期全局行为要求和执行规则。owner 在修改 bot 长期做事方式前应先看这里，避免重复或冲突。",
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
        name: "remember_global_memory",
        description: "写入一条长期全局 memory，适合记录 owner 指定的 bot 长期执行规则、回答协议、输出偏好或默认工作方式。",
        parameters: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            title: { type: "string" },
            content: { type: "string" }
          },
          required: ["title", "content"],
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
        name: "remove_global_memory",
        description: "删除一条已存的长期全局 memory。",
        parameters: {
          type: "object",
          properties: {
            memoryId: { type: "string" }
          },
          required: ["memoryId"],
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
        name: "overwrite_global_memories",
        description: "整组覆写长期全局 memories。",
        parameters: {
          type: "object",
          properties: {
            memories: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  content: { type: "string" }
                },
                required: ["title", "content"],
                additionalProperties: false
              }
            }
          },
          required: ["memories"],
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
    definition: {
      type: "function",
      function: {
        name: "get_persona",
        description: "读取当前长期 persona。凡是 owner 想长期修改口吻、行为规则、查询协议、身份设定或角色边界时，都应先调用它检查当前内容。",
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
        name: "update_persona",
        description: "持久更新 bot 的长期 persona 字段。owner 一旦明确提出长期生效的口吻、规则、查询方式、身份设定或角色边界，就应在确认字段归属后立即调用。若回复中声称“已记住”“以后按这个做”“已写进 persona”，则必须已经完成本工具调用。",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "bot 名字，或角色扮演时应使用的名字。"
            },
            identity: {
              type: "string",
              description: "核心身份、种族、职业、世界观或角色定位。"
            },
            virtualAppearance: {
              type: "string",
              description: "稳定的外貌描述。"
            },
            personality: {
              type: "string",
              description: "稳定的性格特征或气质。"
            },
            hobbies: {
              type: "string",
              description: "稳定的兴趣、爱好或偏爱的活动。"
            },
            likesAndDislikes: {
              type: "string",
              description: "稳定的喜欢、讨厌、口味或禁忌。"
            },
            familyBackground: {
              type: "string",
              description: "稳定的背景设定或个人经历。"
            },
            speakingStyle: {
              type: "string",
              description: "之后聊天时应保持的说话风格，如语气、措辞、句式节奏、称呼或口头禅。"
            },
            secrets: {
              type: "string",
              description: "角色内部长期保留的隐藏设定或秘密背景。"
            },
            residence: {
              type: "string",
              description: "稳定的住处或常驻地点。"
            },
            roleplayRequirements: {
              type: "string",
              description: "额外的长期角色扮演规则、边界或行为要求。"
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
        name: "list_user_memories",
        description: "列出当前用户已存的长期 memories；只有 owner 明确指定 user_id 时才能看别人的。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" }
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
        name: "remember_user_memory",
        description: "为用户写入一条长期 memory，只适合记录该用户自己的稳定偏好、事实、习惯、关系或经历。优先在看过已存 profile 和 memories 后再写。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            memoryId: { type: "string" },
            title: { type: "string" },
            content: { type: "string" }
          },
          required: ["title", "content"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "remove_user_memory",
        description: "删除一条已存的长期 memory；只有 owner 明确指定 user_id 时才能删别人的。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            memoryId: { type: "string" }
          },
          required: ["memoryId"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "overwrite_user_memories",
        description: "整组覆写用户的长期 memories；只有 owner 明确指定 user_id 时才能改别人的。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            memories: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  content: { type: "string" }
                },
                required: ["title", "content"],
                additionalProperties: false
              }
            }
          },
          required: ["memories"],
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

function parseMemoryEntries(args: unknown): Array<{ id?: string; title: string; content: string }> {
  if (typeof args !== "object" || !args || !("memories" in args) || !Array.isArray((args as { memories?: unknown }).memories)) {
    return [];
  }
  return (args as { memories: unknown[] }).memories
    .map((item) => ({
      ...(typeof item === "object" && item && "id" in item && String((item as Record<string, unknown>).id).trim()
        ? { id: String((item as Record<string, unknown>).id).trim() }
        : {}),
      title: typeof item === "object" && item && "title" in item
        ? String((item as Record<string, unknown>).title).trim()
        : "",
      content: typeof item === "object" && item && "content" in item
        ? String((item as Record<string, unknown>).content).trim()
        : ""
    }))
    .filter((item) => item.title && item.content);
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
  async get_global_memories(_toolCall, _args, context) {
    const denied = requireOwner(context.relationship, "Only owner can inspect global memories");
    if (denied) {
      return denied;
    }
    return JSON.stringify(await context.globalMemoryStore.getAll());
  },
  async get_persona(_toolCall, _args, context) {
    return JSON.stringify(await context.personaStore.get());
  },
  async update_persona(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update persona");
    if (denied) {
      return denied;
    }
    const patch = typeof args === "object" && args
      ? Object.fromEntries(
          Object.entries(args as Record<string, unknown>).filter(([, value]) => typeof value === "string")
        )
      : {};
    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ error: "At least one persona field is required" });
    }
    const updated = await context.personaStore.patch(patch);
    await context.setupStore.advanceAfterPersonaUpdate(updated);
    return JSON.stringify(updated);
  },
  async list_user_memories(_toolCall, args, context) {
    const userId = resolveTargetUserId(args, context.lastMessage.userId);
    const denied = requireOwnerOrSelf(context, userId, "Only owner can inspect another user's memories");
    if (denied) {
      return denied;
    }
    const user = await context.userStore.getByUserId(userId);
    return JSON.stringify(user?.memories ?? []);
  },
  async remember_global_memory(_toolCall, args, context) {
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
  },
  async remember_user_memory(_toolCall, args, context) {
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
  },
  async remove_global_memory(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can edit global memories");
    if (denied) {
      return denied;
    }
    const memoryId = getStringField(args, "memoryId");
    if (!memoryId) {
      return JSON.stringify({ error: "memoryId is required" });
    }
    return JSON.stringify(await context.globalMemoryStore.remove(memoryId));
  },
  async remove_user_memory(_toolCall, args, context) {
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
  },
  async overwrite_global_memories(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can overwrite global memories");
    if (denied) {
      return denied;
    }
    return JSON.stringify(await context.globalMemoryStore.overwrite(
      parseMemoryEntries(args)
    ));
  },
  async overwrite_user_memories(_toolCall, args, context) {
    const userId = resolveTargetUserId(args, context.lastMessage.userId);
    const denied = requireOwnerOrSelf(context, userId, "Only owner can overwrite another user's memories");
    if (denied) {
      return denied;
    }
    const updated = await context.userStore.overwriteMemories(
      userId,
      parseMemoryEntries(args)
    );
    return JSON.stringify(updated.memories);
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

import { editablePersonaFieldNames } from "#persona/personaSchema.ts";
import {
  editableRpProfileFieldNames,
  type RpProfile
} from "#modes/rpAssistant/profileSchema.ts";
import {
  editableScenarioProfileFieldNames,
  type ScenarioProfile
} from "#modes/scenarioHost/profileSchema.ts";
import type {
  SessionOperationMode,
  SessionRpProfileOperationMode,
  SessionScenarioProfileOperationMode
} from "#conversation/session/sessionOperationMode.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { resolvePersonaReadinessStatus } from "#persona/personaSetupPolicy.ts";
import type { MemoryCategory, ScopeConflictWarning } from "#memory/memoryCategory.ts";
import {
  buildMemoryRerouteDetails,
  resolveMemoryWriteFinalAction,
  type MemoryDedupDetails,
  type MemoryWriteAction
} from "#memory/writeResult.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";

const personaFieldEnums = [...editablePersonaFieldNames];
const personaPatchFieldNames = new Set(editablePersonaFieldNames);
const rpProfileFieldEnums = [...editableRpProfileFieldNames];
const rpProfilePatchFieldNames = new Set(editableRpProfileFieldNames);
const scenarioProfileFieldEnums = [...editableScenarioProfileFieldNames];
const scenarioProfilePatchFieldNames = new Set(editableScenarioProfileFieldNames);

export const profileToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "get_persona",
        description: "读取当前 persona。需要判断人设、口吻、角色边界或字段现状时使用。",
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
        name: "get_rp_profile",
        description: "读取当前会话中的 RP 全局资料草稿。",
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
        name: "patch_rp_profile",
        description: "按字段 patch 当前会话中的 RP 全局资料草稿，不直接写持久化存储。",
        parameters: {
          type: "object",
          properties: {
            profilePatch: {
              type: "object",
              properties: {
                selfPositioning: { type: "string" },
                socialRole: { type: "string" },
                lifeContext: { type: "string" },
                physicalPresence: { type: "string" },
                bondToUser: { type: "string" },
                closenessPattern: { type: "string" },
                interactionPattern: { type: "string" },
                realityContract: { type: "string" },
                continuityFacts: { type: "string" },
                hardLimits: { type: "string" }
              },
              additionalProperties: false
            }
          },
          required: ["profilePatch"],
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
        name: "clear_rp_profile_field",
        description: "清空当前会话中的一个 RP 全局资料草稿字段。",
        parameters: {
          type: "object",
          properties: {
            profileField: {
              type: "string",
              enum: rpProfileFieldEnums
            }
          },
          required: ["profileField"],
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
        name: "get_scenario_profile",
        description: "读取当前会话中的 Scenario 全局资料草稿。",
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
        name: "patch_scenario_profile",
        description: "按字段 patch 当前会话中的 Scenario 全局资料草稿，不直接写持久化存储。",
        parameters: {
          type: "object",
          properties: {
            profilePatch: {
              type: "object",
              properties: {
                theme: { type: "string" },
                hostStyle: { type: "string" },
                worldBaseline: { type: "string" },
                safetyOrTabooRules: { type: "string" },
                openingPattern: { type: "string" }
              },
              additionalProperties: false
            }
          },
          required: ["profilePatch"],
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
        name: "clear_scenario_profile_field",
        description: "清空当前会话中的一个 Scenario 全局资料草稿字段。",
        parameters: {
          type: "object",
          properties: {
            profileField: {
              type: "string",
              enum: scenarioProfileFieldEnums
            }
          },
          required: ["profileField"],
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
        name: "patch_persona",
        description: "按字段 patch persona。只用于 bot 的名字、性格底色、说话方式和跨模式全局偏好。",
        parameters: {
          type: "object",
          properties: {
            personaPatch: {
              type: "object",
              properties: {
                name: { type: "string" },
                temperament: { type: "string" },
                speakingStyle: { type: "string" },
                globalTraits: { type: "string" },
                generalPreferences: { type: "string" }
              },
              additionalProperties: false
            }
          },
          required: ["personaPatch"],
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
        name: "clear_persona_field",
        description: "清空一个 persona 字段。",
        parameters: {
          type: "object",
          properties: {
            personaField: {
              type: "string",
              enum: personaFieldEnums
            }
          },
          required: ["personaField"],
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
        name: "list_global_rules",
        description: "读取 owner 级长期全局工作流规则。仅 owner 可用。",
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
        name: "upsert_global_rule",
        description: "创建或更新 owner 级长期全局工作流规则。只用于跨任务通用执行偏好，不用于 persona，也不用于某个工具集局部规则。",
        parameters: {
          type: "object",
          properties: {
            ruleId: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            kind: {
              type: "string",
              enum: ["workflow", "constraint", "preference", "other"]
            }
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
        name: "remove_global_rule",
        description: "删除一条全局规则。",
        parameters: {
          type: "object",
          properties: {
            ruleId: { type: "string" }
          },
          required: ["ruleId"],
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
        name: "list_toolset_rules",
        description: "读取工具集绑定的长期规则。可按 toolset_ids 过滤。仅 owner 可用。",
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
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "upsert_toolset_rule",
        description: "创建或更新仅绑定到指定 toolset_ids 的长期规则。不要把跨任务通用规则写进这里。",
        parameters: {
          type: "object",
          properties: {
            ruleId: { type: "string" },
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
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "remove_toolset_rule",
        description: "删除一条工具集规则。",
        parameters: {
          type: "object",
          properties: {
            ruleId: { type: "string" }
          },
          required: ["ruleId"],
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
        description: "读取结构化用户资料。默认读取当前触发用户；owner 可传 user_id 查看其他用户。",
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
        name: "patch_user_profile",
        description: "按字段 patch 结构化用户资料。只写稳定、结构化、适合用户卡片的事实，不要把杂项长期记忆塞进 profileSummary。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            preferredAddress: { type: "string" },
            gender: { type: "string" },
            residence: { type: "string" },
            timezone: { type: "string" },
            occupation: { type: "string" },
            profileSummary: { type: "string" },
            relationshipNote: { type: "string" }
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
        description: "读取用户长期记忆。默认读取当前触发用户；owner 可传 user_id 查看其他用户。",
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
        name: "upsert_user_memory",
        description: "创建或更新用户长期记忆。只写用户特定的长期偏好、边界、习惯、关系背景或事实；结构化字段应优先写 user_profile。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            memoryId: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            kind: {
              type: "string",
              enum: ["preference", "fact", "boundary", "habit", "relationship", "other"]
            },
            importance: {
              type: "integer",
              minimum: 1,
              maximum: 5
            }
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
        description: "删除一条用户长期记忆。",
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
            timezone: { type: "string" },
            occupation: { type: "string" },
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
  }
];

function getStringField(args: unknown, key: string): string {
  return typeof args === "object" && args && key in args
    ? String((args as Record<string, unknown>)[key] ?? "").trim()
    : "";
}

function getIntegerField(args: unknown, key: string): number | null {
  if (typeof args !== "object" || !args || !(key in args)) {
    return null;
  }
  const value = Number((args as Record<string, unknown>)[key]);
  return Number.isInteger(value) ? value : null;
}

function getStringArrayField(args: unknown, key: string): string[] {
  if (typeof args !== "object" || !args || !(key in args) || !Array.isArray((args as Record<string, unknown>)[key])) {
    return [];
  }
  return ((args as Record<string, unknown>)[key] as unknown[])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

async function resolveTargetUserId(args: unknown, context: Parameters<ToolHandler>[2]): Promise<string> {
  return resolveCanonicalUserId(getStringField(args, "user_id") || context.lastMessage.userId, context);
}

async function resolveCanonicalUserId(userId: string, context: Parameters<ToolHandler>[2]): Promise<string> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId || normalizedUserId === context.lastMessage.userId) {
    return normalizedUserId || context.lastMessage.userId;
  }
  const parsedSession = parseChatSessionIdentity(context.lastMessage.sessionId);
  if (!parsedSession || !context.userIdentityStore?.findInternalUserId) {
    return normalizedUserId;
  }
  return (await context.userIdentityStore.findInternalUserId({
    channelId: parsedSession.channelId,
    externalId: normalizedUserId
  })) ?? normalizedUserId;
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
  timezone?: string;
  occupation?: string;
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
    ...(typeof args === "object" && args && "timezone" in args
      ? { timezone: String((args as { timezone: unknown }).timezone) }
      : {}),
    ...(typeof args === "object" && args && "occupation" in args
      ? { occupation: String((args as { occupation: unknown }).occupation) }
      : {}),
    ...(typeof args === "object" && args && "profileSummary" in args
      ? { profileSummary: String((args as { profileSummary: unknown }).profileSummary) }
      : {}),
    ...(typeof args === "object" && args && "relationshipNote" in args
      ? { relationshipNote: String((args as { relationshipNote: unknown }).relationshipNote) }
      : {})
  };
}

function toUserProfilePayload(
  user: {
    userId: string;
    relationship?: string;
    specialRole?: string;
    preferredAddress?: string;
    gender?: string;
    residence?: string;
    timezone?: string;
    occupation?: string;
    profileSummary?: string;
    relationshipNote?: string;
  } | null,
  senderName?: string
) {
  return {
    user_id: user?.userId ?? null,
    senderName: senderName ?? null,
    relationship: user?.relationship ?? null,
    specialRole: user?.specialRole ?? null,
    preferredAddress: user?.preferredAddress ?? null,
    gender: user?.gender ?? null,
    residence: user?.residence ?? null,
    timezone: user?.timezone ?? null,
    occupation: user?.occupation ?? null,
    profileSummary: user?.profileSummary ?? null,
    relationshipNote: user?.relationshipNote ?? null
  };
}

function serializeWriteResult(input: {
  targetCategory: MemoryCategory;
  action: MemoryWriteAction;
  itemKey: string;
  item: unknown;
  itemId?: string | null;
  warning?: ScopeConflictWarning | null;
  dedup?: MemoryDedupDetails | null;
}): string {
  const warning = input.warning ?? null;
  return JSON.stringify({
    targetCategory: input.targetCategory,
    action: input.action,
    finalAction: resolveMemoryWriteFinalAction(input.action, warning),
    itemId: input.itemId ?? null,
    ...(input.dedup
      ? {
          dedup: {
            matchedBy: input.dedup.matchedBy,
            matchedExistingId: input.dedup.matchedExistingId,
            similarityScore: input.dedup.similarityScore ?? null
          }
        }
      : {}),
    reroute: buildMemoryRerouteDetails(warning),
    ...(warning ? { warnings: [warning] } : {}),
    [input.itemKey]: input.item
  });
}

function parsePersonaPatch(args: unknown): Record<string, string> {
  if (typeof args !== "object" || !args || !("personaPatch" in args) || typeof (args as { personaPatch?: unknown }).personaPatch !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries((args as { personaPatch: Record<string, unknown> }).personaPatch)
      .filter(([key, value]) => personaPatchFieldNames.has(key as typeof editablePersonaFieldNames[number]) && typeof value === "string")
      .map(([key, value]) => [key, String(value)])
  );
}

function parseProfilePatch(
  args: unknown,
  allowedFieldNames: Set<string>
): Record<string, string> {
  if (typeof args !== "object" || !args || !("profilePatch" in args) || typeof (args as { profilePatch?: unknown }).profilePatch !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries((args as { profilePatch: Record<string, unknown> }).profilePatch)
      .filter(([key, value]) => allowedFieldNames.has(key) && typeof value === "string")
      .map(([key, value]) => [key, String(value)])
  );
}

async function syncPersonaReadiness(
  context: Parameters<ToolHandler>[2],
  persona: unknown
): Promise<void> {
  await context.globalProfileReadinessStore.setPersonaReadiness(
    resolvePersonaReadinessStatus(context.config, persona as never)
  );
}

function serializeDraftWriteResult(input: {
  targetCategory: "persona_draft" | "rp_profile_draft" | "scenario_profile_draft";
  itemKey: "persona" | "profile";
  item: unknown;
}): string {
  return JSON.stringify({
    targetCategory: input.targetCategory,
    action: "updated_existing",
    finalAction: "updated_existing",
    [input.itemKey]: input.item
  });
}

function resolvePersonaDraftOperation(context: Parameters<ToolHandler>[2]) {
  const sessionId = context.lastMessage?.sessionId;
  if (!sessionId || !context.sessionManager?.getOperationMode) {
    return null;
  }
  const operationMode = context.sessionManager.getOperationMode(sessionId);
  if (operationMode.kind !== "persona_setup" && operationMode.kind !== "persona_config") {
    return null;
  }
  return {
    sessionId,
    operationMode,
    draft: operationMode.draft
  };
}

function resolveModeProfileDraftOperation(
  context: Parameters<ToolHandler>[2],
  modeId: "rp_assistant"
): {
  sessionId: string;
  operationMode: SessionRpProfileOperationMode;
  draft: RpProfile;
} | null;
function resolveModeProfileDraftOperation(
  context: Parameters<ToolHandler>[2],
  modeId: "scenario_host"
): {
  sessionId: string;
  operationMode: SessionScenarioProfileOperationMode;
  draft: ScenarioProfile;
} | null;
function resolveModeProfileDraftOperation(
  context: Parameters<ToolHandler>[2],
  modeId: "rp_assistant" | "scenario_host"
) {
  const sessionId = context.lastMessage?.sessionId;
  if (!sessionId || !context.sessionManager?.getOperationMode) {
    return null;
  }
  const operationMode = context.sessionManager.getOperationMode(sessionId);
  if (
    (operationMode.kind !== "mode_setup" && operationMode.kind !== "mode_config")
    || operationMode.modeId !== modeId
  ) {
    return null;
  }
  if (modeId === "rp_assistant") {
    return {
      sessionId,
      operationMode,
      draft: operationMode.draft
    };
  }
  return {
    sessionId,
    operationMode,
    draft: operationMode.draft
  };
}

function persistDraftOperation(
  context: Parameters<ToolHandler>[2],
  sessionId: string,
  operationMode: SessionOperationMode
) {
  context.sessionManager.setOperationMode(sessionId, operationMode);
  context.persistSession?.(sessionId, "profile_draft_updated");
}

export const profileToolHandlers: Record<string, ToolHandler> = {
  async get_persona(_toolCall, _args, context) {
    const draftOperation = resolvePersonaDraftOperation(context);
    if (draftOperation) {
      return JSON.stringify(draftOperation.draft);
    }
    return JSON.stringify(await context.personaStore.get());
  },
  async patch_persona(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update persona");
    if (denied) {
      return denied;
    }
    const personaPatch = parsePersonaPatch(args);
    if (Object.keys(personaPatch).length === 0) {
      return JSON.stringify({ error: "personaPatch with at least one string field is required" });
    }
    const draftOperation = resolvePersonaDraftOperation(context);
    if (draftOperation) {
      const nextDraft = {
        ...draftOperation.draft,
        ...personaPatch
      };
      persistDraftOperation(context, draftOperation.sessionId, {
        ...draftOperation.operationMode,
        draft: nextDraft
      });
      return serializeDraftWriteResult({
        targetCategory: "persona_draft",
        itemKey: "persona",
        item: nextDraft
      });
    }
    const personaStore = context.personaStore as {
      patch: (patch: Record<string, string>) => Promise<unknown>;
      patchWithDiagnostics?: (patch: Record<string, string>) => Promise<{ persona: unknown; warning: ScopeConflictWarning | null }>;
    };
    const result = personaStore.patchWithDiagnostics
      ? await personaStore.patchWithDiagnostics(personaPatch)
      : { persona: await personaStore.patch(personaPatch), warning: null };
    await context.setupStore.advanceAfterPersonaUpdate(result.persona as any);
    await syncPersonaReadiness(context, result.persona);
    return serializeWriteResult({
      targetCategory: "persona",
      action: "updated_existing",
      itemKey: "persona",
      item: result.persona,
      warning: result.warning
    });
  },
  async clear_persona_field(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update persona");
    if (denied) {
      return denied;
    }
    const personaField = getStringField(args, "personaField");
    if (!personaField || !personaFieldEnums.includes(personaField as typeof personaFieldEnums[number])) {
      return JSON.stringify({ error: "personaField is required" });
    }
    const draftOperation = resolvePersonaDraftOperation(context);
    if (draftOperation) {
      const nextDraft = {
        ...draftOperation.draft,
        [personaField]: ""
      };
      persistDraftOperation(context, draftOperation.sessionId, {
        ...draftOperation.operationMode,
        draft: nextDraft
      });
      return serializeDraftWriteResult({
        targetCategory: "persona_draft",
        itemKey: "persona",
        item: nextDraft
      });
    }
    const personaStore = context.personaStore as {
      patch: (patch: Record<string, string>) => Promise<unknown>;
      patchWithDiagnostics?: (patch: Record<string, string>) => Promise<{ persona: unknown; warning: ScopeConflictWarning | null }>;
    };
    const result = personaStore.patchWithDiagnostics
      ? await personaStore.patchWithDiagnostics({ [personaField]: "" })
      : { persona: await personaStore.patch({ [personaField]: "" }), warning: null };
    await context.setupStore.advanceAfterPersonaUpdate(result.persona as any);
    await syncPersonaReadiness(context, result.persona);
    return serializeWriteResult({
      targetCategory: "persona",
      action: "updated_existing",
      itemKey: "persona",
      item: result.persona,
      warning: result.warning
    });
  },
  async get_rp_profile(_toolCall, _args, context) {
    const draftOperation = resolveModeProfileDraftOperation(context, "rp_assistant");
    if (!draftOperation) {
      return JSON.stringify({ error: "RP profile draft is only available in rp setup/config mode" });
    }
    return JSON.stringify(draftOperation.draft);
  },
  async patch_rp_profile(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update RP profile drafts");
    if (denied) {
      return denied;
    }
    const draftOperation = resolveModeProfileDraftOperation(context, "rp_assistant");
    if (!draftOperation) {
      return JSON.stringify({ error: "RP profile draft is only available in rp setup/config mode" });
    }
    const profilePatch = parseProfilePatch(args, rpProfilePatchFieldNames);
    if (Object.keys(profilePatch).length === 0) {
      return JSON.stringify({ error: "profilePatch with at least one string field is required" });
    }
    const nextDraft: RpProfile = {
      ...(draftOperation.draft as RpProfile),
      ...profilePatch
    };
    persistDraftOperation(context, draftOperation.sessionId, {
      ...draftOperation.operationMode,
      draft: nextDraft
    });
    return serializeDraftWriteResult({
      targetCategory: "rp_profile_draft",
      itemKey: "profile",
      item: nextDraft
    });
  },
  async clear_rp_profile_field(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update RP profile drafts");
    if (denied) {
      return denied;
    }
    const draftOperation = resolveModeProfileDraftOperation(context, "rp_assistant");
    if (!draftOperation) {
      return JSON.stringify({ error: "RP profile draft is only available in rp setup/config mode" });
    }
    const profileField = getStringField(args, "profileField");
    if (!profileField || !rpProfileFieldEnums.includes(profileField as typeof rpProfileFieldEnums[number])) {
      return JSON.stringify({ error: "profileField is required" });
    }
    const nextDraft: RpProfile = {
      ...(draftOperation.draft as RpProfile),
      [profileField]: ""
    };
    persistDraftOperation(context, draftOperation.sessionId, {
      ...draftOperation.operationMode,
      draft: nextDraft
    });
    return serializeDraftWriteResult({
      targetCategory: "rp_profile_draft",
      itemKey: "profile",
      item: nextDraft
    });
  },
  async get_scenario_profile(_toolCall, _args, context) {
    const draftOperation = resolveModeProfileDraftOperation(context, "scenario_host");
    if (!draftOperation) {
      return JSON.stringify({ error: "Scenario profile draft is only available in scenario setup/config mode" });
    }
    return JSON.stringify(draftOperation.draft);
  },
  async patch_scenario_profile(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update scenario profile drafts");
    if (denied) {
      return denied;
    }
    const draftOperation = resolveModeProfileDraftOperation(context, "scenario_host");
    if (!draftOperation) {
      return JSON.stringify({ error: "Scenario profile draft is only available in scenario setup/config mode" });
    }
    const profilePatch = parseProfilePatch(args, scenarioProfilePatchFieldNames);
    if (Object.keys(profilePatch).length === 0) {
      return JSON.stringify({ error: "profilePatch with at least one string field is required" });
    }
    const nextDraft: ScenarioProfile = {
      ...(draftOperation.draft as ScenarioProfile),
      ...profilePatch
    };
    persistDraftOperation(context, draftOperation.sessionId, {
      ...draftOperation.operationMode,
      draft: nextDraft
    });
    return serializeDraftWriteResult({
      targetCategory: "scenario_profile_draft",
      itemKey: "profile",
      item: nextDraft
    });
  },
  async clear_scenario_profile_field(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update scenario profile drafts");
    if (denied) {
      return denied;
    }
    const draftOperation = resolveModeProfileDraftOperation(context, "scenario_host");
    if (!draftOperation) {
      return JSON.stringify({ error: "Scenario profile draft is only available in scenario setup/config mode" });
    }
    const profileField = getStringField(args, "profileField");
    if (!profileField || !scenarioProfileFieldEnums.includes(profileField as typeof scenarioProfileFieldEnums[number])) {
      return JSON.stringify({ error: "profileField is required" });
    }
    const nextDraft: ScenarioProfile = {
      ...(draftOperation.draft as ScenarioProfile),
      [profileField]: ""
    };
    persistDraftOperation(context, draftOperation.sessionId, {
      ...draftOperation.operationMode,
      draft: nextDraft
    });
    return serializeDraftWriteResult({
      targetCategory: "scenario_profile_draft",
      itemKey: "profile",
      item: nextDraft
    });
  },
  async list_global_rules(_toolCall, _args, context) {
    const denied = requireOwner(context.relationship, "Only owner can inspect global rules");
    if (denied) {
      return denied;
    }
    return JSON.stringify(await context.globalRuleStore.getAll());
  },
  async upsert_global_rule(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can edit global rules");
    if (denied) {
      return denied;
    }
    const title = getStringField(args, "title");
    const content = getStringField(args, "content");
    if (!title || !content) {
      return JSON.stringify({ error: "title and content are required" });
    }
    const result = await context.globalRuleStore.upsert({
      ...(getStringField(args, "ruleId") ? { ruleId: getStringField(args, "ruleId") } : {}),
      title,
      content,
      ...(getStringField(args, "kind") ? { kind: getStringField(args, "kind") as "workflow" | "constraint" | "preference" | "other" } : {})
    });
    return serializeWriteResult({
      targetCategory: "global_rules",
      action: result.action,
      itemKey: "rule",
      item: result.item,
      itemId: result.item.id,
      dedup: result.dedup,
      warning: result.warning
    });
  },
  async remove_global_rule(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can edit global rules");
    if (denied) {
      return denied;
    }
    const ruleId = getStringField(args, "ruleId");
    if (!ruleId) {
      return JSON.stringify({ error: "ruleId is required" });
    }
    const remaining = await context.globalRuleStore.remove(ruleId);
    return JSON.stringify({ removed: true, ruleId, remaining });
  },
  async list_toolset_rules(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can inspect toolset rules");
    if (denied) {
      return denied;
    }
    const toolsetIds = new Set(getStringArrayField(args, "toolset_ids"));
    const rules = await context.toolsetRuleStore.getAll();
    return JSON.stringify(
      toolsetIds.size > 0
        ? rules.filter((item) => item.toolsetIds.some((id) => toolsetIds.has(id)))
        : rules
    );
  },
  async upsert_toolset_rule(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can edit toolset rules");
    if (denied) {
      return denied;
    }
    const title = getStringField(args, "title");
    const content = getStringField(args, "content");
    const toolsetIds = getStringArrayField(args, "toolset_ids");
    if (!title || !content || toolsetIds.length === 0) {
      return JSON.stringify({ error: "title, content and toolset_ids are required" });
    }
    const result = await context.toolsetRuleStore.upsert({
      ...(getStringField(args, "ruleId") ? { ruleId: getStringField(args, "ruleId") } : {}),
      title,
      content,
      toolsetIds,
      source: "owner_explicit"
    });
    return serializeWriteResult({
      targetCategory: "toolset_rules",
      action: result.action,
      itemKey: "rule",
      item: result.item,
      itemId: result.item.id,
      dedup: result.dedup,
      warning: result.warning
    });
  },
  async remove_toolset_rule(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can edit toolset rules");
    if (denied) {
      return denied;
    }
    const ruleId = getStringField(args, "ruleId");
    if (!ruleId) {
      return JSON.stringify({ error: "ruleId is required" });
    }
    const remaining = await context.toolsetRuleStore.remove(ruleId);
    return JSON.stringify({ removed: true, ruleId, remaining });
  },
  async get_user_profile(_toolCall, args, context) {
    const userId = await resolveTargetUserId(args, context);
    const denied = requireOwnerOrSelf(context, userId, "Only owner can inspect another user's profile");
    if (denied) {
      return denied;
    }
    const user = userId === context.lastMessage.userId
      ? context.currentUser
      : await context.userStore.getByUserId(userId);
    return JSON.stringify(toUserProfilePayload(user, userId === context.lastMessage.userId ? context.lastMessage.senderName : undefined));
  },
  async patch_user_profile(_toolCall, args, context) {
    const userId = await resolveTargetUserId(args, context);
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
    return serializeWriteResult({
      targetCategory: "user_profile",
      action: "updated_existing",
      itemKey: "profile",
      item: toUserProfilePayload(updated, userId === context.lastMessage.userId ? context.lastMessage.senderName : undefined),
      itemId: userId
    });
  },
  async list_user_memories(_toolCall, args, context) {
    const userId = await resolveTargetUserId(args, context);
    const denied = requireOwnerOrSelf(context, userId, "Only owner can inspect another user's memories");
    if (denied) {
      return denied;
    }
    const user = userId === context.lastMessage.userId
      ? context.currentUser
      : await context.userStore.getByUserId(userId);
    return JSON.stringify(user?.memories ?? []);
  },
  async upsert_user_memory(_toolCall, args, context) {
    const userId = await resolveTargetUserId(args, context);
    const denied = requireOwnerOrSelf(context, userId, "Only owner can edit another user's memories");
    if (denied) {
      return denied;
    }
    const title = getStringField(args, "title");
    const content = getStringField(args, "content");
    if (!title || !content) {
      return JSON.stringify({ error: "title and content are required" });
    }
    const result = await context.userStore.upsertMemory({
      userId,
      ...(getStringField(args, "memoryId") ? { memoryId: getStringField(args, "memoryId") } : {}),
      title,
      content,
      ...(getStringField(args, "kind") ? { kind: getStringField(args, "kind") as "preference" | "fact" | "boundary" | "habit" | "relationship" | "other" } : {}),
      ...(getIntegerField(args, "importance") !== null ? { importance: getIntegerField(args, "importance")! } : {}),
      source: context.relationship === "owner" && userId !== context.lastMessage.userId ? "owner_explicit" : "user_explicit"
    });
    return serializeWriteResult({
      targetCategory: "user_memories",
      action: result.action,
      itemKey: "memory",
      item: result.item,
      itemId: result.item.id,
      dedup: result.dedup,
      warning: result.warning
    });
  },
  async remove_user_memory(_toolCall, args, context) {
    const userId = await resolveTargetUserId(args, context);
    const denied = requireOwnerOrSelf(context, userId, "Only owner can edit another user's memories");
    if (denied) {
      return denied;
    }
    const memoryId = getStringField(args, "memoryId");
    if (!memoryId) {
      return JSON.stringify({ error: "memoryId is required" });
    }
    const updated = await context.userStore.removeMemory(userId, memoryId);
    return JSON.stringify({ removed: Boolean(updated), memoryId, remaining: updated?.memories ?? [] });
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
    const resolvedUserId = await resolveCanonicalUserId(userId, context);
    const updated = await context.userStore.registerKnownUser({
      userId: resolvedUserId,
      ...parseUserProfilePatch(args)
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
    const resolvedUserId = await resolveCanonicalUserId(userId, context);
    const updated = await context.userStore.setSpecialRole(resolvedUserId, specialRole as "npc" | "none");
    await context.npcDirectory.refresh(context.userStore);
    return JSON.stringify(updated);
  }
};

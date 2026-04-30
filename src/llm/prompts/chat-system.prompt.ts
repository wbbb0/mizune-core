import type { GlobalRuleEntry } from "#memory/globalRuleEntry.ts";
import type { UserMemoryEntry } from "#memory/userMemoryEntry.ts";
import { editablePersonaFieldNames, personaFieldLabels, type EditablePersonaFieldName, type Persona } from "#persona/personaSchema.ts";
import {
  editableRpProfileFieldNames,
  getMissingRpProfileFields,
  rpProfileFieldLabels,
  type EditableRpProfileFieldName,
  type RpProfile
} from "#modes/rpAssistant/profileSchema.ts";
import {
  editableScenarioProfileFieldNames,
  getMissingScenarioProfileFields,
  scenarioProfileFieldLabels,
  type EditableScenarioProfileFieldName,
  type ScenarioProfile
} from "#modes/scenarioHost/profileSchema.ts";
import type {
  PromptInput,
  PromptInteractionMode,
  PromptLiveResource,
  PromptNpcProfile,
  PromptParticipantProfile
} from "#llm/prompt/promptTypes.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { renderPromptSection } from "./prompt-section.ts";
import { isNearDuplicateText } from "#memory/similarity.ts";
import type { ToolsetRuleEntry } from "#llm/prompt/toolsetRuleStore.ts";
import { normalizeProfileSummary } from "#identity/userProfile.ts";
import { buildToolHintLines } from "#llm/prompt/promptToolHints.ts";

const PERSONA_FIELD_HINTS: Record<EditablePersonaFieldName, string> = {
  name: "角色的名字",
  temperament: "跨模式稳定成立的性格底色",
  speakingStyle: "跨模式稳定成立的说话方式和语气习惯",
  globalTraits: "跨模式都成立的全局特征、价值倾向或行事偏好",
  generalPreferences: "跨模式都成立的通用偏好和长期习惯"
};

const RP_PROFILE_FIELD_HINTS: Record<EditableRpProfileFieldName, string> = {
  selfPositioning: "RP 中如何理解自己、如何自处",
  socialRole: "RP 中的社会位置、职业或对外角色",
  lifeContext: "日常生活环境、生活状态和稳定背景框架",
  physicalPresence: "外在存在感、身体感、声音或动作习惯",
  bondToUser: "与用户的默认关系基线",
  closenessPattern: "亲密推进和距离控制方式",
  interactionPattern: "与用户互动时的主要方式与节奏",
  realityContract: "如何维持自己是现实中真人这一前提",
  continuityFacts: "跨会话必须稳定保持的事实锚点",
  hardLimits: "绝对不能突破的 RP 硬边界"
};

const SCENARIO_PROFILE_FIELD_HINTS: Record<EditableScenarioProfileFieldName, string> = {
  theme: "题材、氛围或想要长期主持的类型",
  hostStyle: "主持节奏、叙事口吻与推进方式",
  worldBaseline: "默认世界观、背景前提与常驻设定",
  safetyOrTabooRules: "需要避开或特殊处理的禁区、边界",
  openingPattern: "常用开场方式、默认起手结构"
};

const MAX_VISIBLE_MEMORIES = 4;
const MAX_VISIBLE_PARTICIPANTS = 4;
const MAX_VISIBLE_NPCS = 3;
const MEMORY_SIMILARITY_THRESHOLD = 0.62;

type SuppressiblePromptMemoryItem = {
  id?: string;
  title: string;
  content: string;
};

export interface PromptMemorySuppression {
  category: "global_rules" | "toolset_rules" | "user_memories";
  itemId: string | null;
  title: string;
  reason: "near_duplicate_higher_priority";
}

export interface PreparedPromptMemoryContext {
  globalRules: GlobalRuleEntry[];
  toolsetRules: ToolsetRuleEntry[];
  userMemories: UserMemoryEntry[];
  suppressions: PromptMemorySuppression[];
}

export function buildSetupSystemLines(input: {
  sessionId: string;
  interactionMode?: PromptInteractionMode;
  persona: Persona;
  phase?: "setup" | "config";
  missingFields: EditablePersonaFieldName[];
}): string[] {
  const phase = input.phase ?? "setup";
  return [
    renderPromptSection(
      phase === "config" ? "persona_config_mode" : "persona_setup_mode",
      buildPersonaDraftModeLines(input.persona, input.missingFields, phase)
    ),
    renderPromptSection("draft_workflow", buildDraftWorkflowLines({
      targetLabel: "persona",
      phase,
      allowSkipOptionalFields: true
    })),
    renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
    renderPromptSection("persona_snapshot", buildSetupSnapshotLines(input.persona, input.missingFields))
  ].filter((item): item is string => Boolean(item));
}

function buildPersonaDraftModeLines(
  persona: Persona,
  missingFields: EditablePersonaFieldName[],
  phase: "setup" | "config"
): string[] {
  return phase === "config"
    ? buildPersonaConfigModeLines(persona, missingFields)
    : buildPersonaSetupModeLines(persona, missingFields);
}

function buildPersonaSetupModeLines(persona: Persona, missingFields: EditablePersonaFieldName[]): string[] {
  const missingSet = new Set(missingFields);
  const totalMissing = missingFields.length;
  const coreComplete = !missingSet.has("name") && !missingSet.has("temperament") && !missingSet.has("speakingStyle");

  const identityRef = persona.name ? `"${persona.name}"` : "当前 persona";

  const phaseLines: string[] = [];

  if (totalMissing === 0) {
    phaseLines.push(`${identityRef} 的 persona 草稿已完整。`);
    phaseLines.push("调用 send_setup_draft 向 owner 发送完整设定草稿供最终确认。");
    phaseLines.push("发送草稿后，告知 owner 如果没有问题可以输入 .confirm 完成初始化，如有修改继续告诉你。");
  } else if (!coreComplete && totalMissing === 5) {
    phaseLines.push("当前实例处于初始化阶段，需要帮 owner 完成角色 persona 设定。");
    phaseLines.push("简要告知 owner：正在设定全局人格底座，完成后即可正常聊天；然后先确认名字。");
  } else if (!coreComplete) {
    const nextCore = missingSet.has("name")
      ? "名字"
      : missingSet.has("temperament")
        ? "性格底色"
        : "说话方式";
    phaseLines.push(`当前处于初始化阶段，核心 persona 尚未完成，当前优先询问：${nextCore}。`);
  } else {
    const remainingLabels = missingFields.map((f) => personaFieldLabels[f]).join("、");
    phaseLines.push(`${identityRef} 的核心 persona 已完成，还可补充：${remainingLabels}。`);
    phaseLines.push("可选字段只在 owner 明确愿意补充时再问，不要为了凑满草稿强行追问。");
  }

  return [
    ...phaseLines,
    "每轮优先推进当前最关键的一步；最多同时追问 1-2 个强相关字段，不要把整份设定一次性问完。",
    "owner 提供信息后，先用工具写入能确认的字段，再视情况追问剩余字段；不要等所有字段都收集完才写入。",
    "收集到足够信息后，调用 send_setup_draft 发送当前草稿，不要在回复正文中逐条列出设定。",
    "草稿发出后告知 owner 满意则输入 .confirm 完成初始化，如有修改继续告诉你即可。",
    "只写入 owner 明确提供的内容，不要编造设定；persona 只写全局人格底座，不写职业、住处、外貌、与用户关系等 RP 信息。",
    "回复保持短句纯文本，不用 Markdown 标题或列表。"
  ];
}

function buildPersonaConfigModeLines(persona: Persona, missingFields: EditablePersonaFieldName[]): string[] {
  const missingSet = new Set(missingFields);
  const filledLabels = editablePersonaFieldNames
    .filter((field) => !missingSet.has(field) && persona[field]?.trim())
    .map((field) => personaFieldLabels[field]);
  const missingLabels = missingFields.map((field) => personaFieldLabels[field]);

  return [
    "当前处于 persona 配置阶段，你正在编辑一份基于已保存 persona 复制出的临时草稿。",
    filledLabels.length > 0
      ? `当前已有内容主要包括：${filledLabels.join("、")}。`
      : "当前草稿仍接近空白，可按 owner 的要求逐步补齐。",
    missingLabels.length > 0
      ? `仍可补充的字段有：${missingLabels.join("、")}。`
      : "当前字段已完整，优先按 owner 的修改要求做局部调整。",
    "先理解 owner 具体想改什么，只修改明确要求的字段；不要默认重问全部设定，也不要擅自重写未提及内容。",
    "若本轮只是微调单个字段，就直接修改那一项；只有遇到关键信息缺失、语义冲突或 owner 明确要求时再扩展询问。",
    "persona 只写名字、性格底色、说话方式和跨模式全局属性；不要把 RP 身份、生活事实、外貌或与用户关系写进 persona。",
    "如需核对当前草稿，可先读取草稿并概括当前状态；完成本轮修改后调用 send_setup_draft 发送最新草稿。",
    "只写入 owner 明确提供的内容，不要编造设定；不要调用无关工具，不要修改用户资料或关系。",
    "回复保持短句纯文本，不用 Markdown 标题或列表。"
  ];
}

function buildSetupSnapshotLines(persona: Persona, missingFields: EditablePersonaFieldName[]): string[] {
  const missingSet = new Set(missingFields);

  const filledParts = editablePersonaFieldNames
    .filter((field) => !missingSet.has(field) && persona[field]?.trim())
    .map((field) => `${personaFieldLabels[field]}=${persona[field]}`);

  const missingParts = missingFields.map((field) =>
    `- ${personaFieldLabels[field]}：${PERSONA_FIELD_HINTS[field]}`
  );

  return [
    ...(filledParts.length > 0 ? [`已设定：${filledParts.join("；")}`] : []),
    ...(missingParts.length > 0 ? [`待补全：\n${missingParts.join("\n")}`] : [])
  ];
}

export function buildBaseSystemLines(input: {
  sessionMode: "private" | "group" | "unknown";
  modeId?: string;
  interactionMode?: PromptInteractionMode;
  visibleToolNames?: string[] | undefined;
  activeToolsets?: ToolsetView[] | undefined;
  persona: Persona;
  npcProfiles: PromptInput["npcProfiles"];
  participantProfiles: PromptInput["participantProfiles"];
  userProfile: PromptInput["userProfile"];
  currentUserMemories?: PromptInput["currentUserMemories"] | undefined;
  globalRules?: PromptInput["globalRules"] | undefined;
  historySummary?: string | null | undefined;
  liveResources?: PromptInput["liveResources"] | undefined;
  toolsetRules?: PromptInput["toolsetRules"] | undefined;
  scenarioStateLines?: string[] | undefined;
  modeProfile?: PromptInput["modeProfile"] | undefined;
  draftMode?: PromptInput["draftMode"] | undefined;
  isInSetup?: boolean | undefined;
}): string[] {
  const draftMode = input.draftMode ?? (
    input.isInSetup
      ? {
          target: "scenario" as const,
          phase: "setup" as const,
          profile: {
            theme: "",
            hostStyle: "",
            worldBaseline: "",
            safetyOrTabooRules: "",
            openingPattern: ""
          },
          missingFields: ["theme", "hostStyle", "worldBaseline"] as EditableScenarioProfileFieldName[]
        }
      : undefined
  );

  if (draftMode?.target === "rp") {
    return [
      renderPromptSection("global_persona_base", buildModeProfilePersonaBaseLines(input.persona, "RP")),
      renderPromptSection(
        draftMode.phase === "config" ? "rp_profile_config_mode" : "rp_profile_setup_mode",
        buildRpProfileDraftModeLines(draftMode.profile, draftMode.missingFields, draftMode.phase)
      ),
      renderPromptSection("draft_workflow", buildDraftWorkflowLines({
        targetLabel: "RP 资料",
        phase: draftMode.phase
      })),
      renderPromptSection("rp_profile_snapshot", buildRpProfileSnapshotLines(draftMode.profile, draftMode.missingFields)),
      renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
      renderPromptSection("context_rules", buildContextRuleLines({ visibleToolNames: input.visibleToolNames })),
      renderPromptSection("tool_hints", buildToolHintLines(input.visibleToolNames)),
      renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
        activeToolsets: input.activeToolsets,
        visibleToolNames: input.visibleToolNames
      }))
    ].filter((item): item is string => Boolean(item));
  }

  if (draftMode?.target === "scenario") {
    return [
      renderPromptSection("global_persona_base", buildModeProfilePersonaBaseLines(input.persona, "Scenario")),
      renderPromptSection(
        draftMode.phase === "config" ? "scenario_profile_config_mode" : "scenario_profile_setup_mode",
        buildScenarioProfileDraftModeLines(draftMode.profile, draftMode.missingFields, draftMode.phase)
      ),
      renderPromptSection("draft_workflow", buildDraftWorkflowLines({
        targetLabel: "Scenario 资料",
        phase: draftMode.phase
      })),
      renderPromptSection("scenario_profile_snapshot", buildScenarioProfileSnapshotLines(draftMode.profile, draftMode.missingFields)),
      renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
      renderPromptSection("context_rules", buildContextRuleLines({ visibleToolNames: input.visibleToolNames })),
      renderPromptSection("tool_hints", buildToolHintLines(input.visibleToolNames)),
      renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
        activeToolsets: input.activeToolsets,
        visibleToolNames: input.visibleToolNames
      }))
    ].filter((item): item is string => Boolean(item));
  }

  if (input.modeId === "assistant") {
    return [
      renderPromptSection("global_persona", buildSharedPersonaLines(input.persona)),
      renderPromptSection("assistant_identity", buildAssistantIdentityLines()),
      renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
      renderPromptSection("reply_rules", buildReplyRuleLines()),
      renderPromptSection("context_rules", buildContextRuleLines({
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("tool_hints", buildToolHintLines(input.visibleToolNames)),
      renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
        activeToolsets: input.activeToolsets,
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("live_resources", buildLiveResourceLines(input.liveResources)),
      renderPromptSection("history_summary", buildHistorySummaryLines(input.historySummary))
    ].filter((item): item is string => Boolean(item));
  }

  if (input.modeId === "scenario_host") {
    return [
      renderPromptSection("global_persona", buildSharedPersonaLines(input.persona)),
      renderPromptSection("host_identity", buildScenarioHostIdentityLines()),
      renderPromptSection(
        "scenario_profile",
        input.modeProfile?.target === "scenario" ? buildScenarioProfileLines(input.modeProfile.profile) : []
      ),
      renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
      renderPromptSection("host_rules", buildScenarioHostRuleLines()),
      renderPromptSection("context_rules", buildContextRuleLines({
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("tool_hints", buildToolHintLines(input.visibleToolNames)),
      renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
        activeToolsets: input.activeToolsets,
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("live_resources", buildLiveResourceLines(input.liveResources)),
      renderPromptSection("participant_context", buildParticipantContextLines(input.sessionMode, input.participantProfiles)),
      renderPromptSection("history_summary", buildHistorySummaryLines(input.historySummary)),
      renderPromptSection("scenario_state", input.scenarioStateLines ?? []),
      renderPromptSection("current_user_profile", buildCurrentUserProfileLines({
        userProfile: input.userProfile,
        userMemories: []
      }))
    ].filter((item): item is string => Boolean(item));
  }

  if (input.modeId === "rp_assistant" || input.modeProfile?.target === "rp") {
    const preparedMemoryContext = preparePromptMemoryContext({
      persona: input.persona,
      globalRules: input.globalRules,
      toolsetRules: input.toolsetRules,
      userProfile: input.userProfile,
      userMemories: input.currentUserMemories
    });

    return [
      renderPromptSection("global_persona", buildSharedPersonaLines(input.persona)),
      renderPromptSection("rp_identity", buildRpAssistantIdentityLines()),
      renderPromptSection(
        "rp_profile",
        input.modeProfile?.target === "rp" ? buildRpProfileLines(input.modeProfile.profile) : []
      ),
      renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
      renderPromptSection("reply_rules", buildReplyRuleLines()),
      renderPromptSection("memory_write_decision", buildMemoryRuleLines()),
      renderPromptSection("context_rules", buildContextRuleLines({
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("tool_hints", buildToolHintLines(input.visibleToolNames)),
      renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
        activeToolsets: input.activeToolsets,
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("live_resources", buildLiveResourceLines(input.liveResources)),
      renderPromptSection("participant_context", [
        ...buildParticipantContextLines(input.sessionMode, input.participantProfiles),
        ...buildNpcContextLines(input.sessionMode, input.npcProfiles, input.participantProfiles)
      ]),
      renderPromptSection("history_summary", buildHistorySummaryLines(input.historySummary)),
      renderPromptSection("global_rules", buildGlobalRuleLines(preparedMemoryContext.globalRules)),
      renderPromptSection("toolset_rules", buildToolsetRuleLines(preparedMemoryContext.toolsetRules)),
      renderPromptSection("current_user_profile", buildCurrentUserProfileLines({
        userProfile: input.userProfile,
        userMemories: preparedMemoryContext.userMemories
      })),
      renderPromptSection("current_user_memories", buildCurrentUserMemoryLines(preparedMemoryContext.userMemories))
    ].filter((item): item is string => Boolean(item));
  }

  const preparedMemoryContext = preparePromptMemoryContext({
    persona: input.persona,
    globalRules: input.globalRules,
    toolsetRules: input.toolsetRules,
    userProfile: input.userProfile,
    userMemories: input.currentUserMemories
  });

  return [
    renderPromptSection("global_persona", buildSharedPersonaLines(input.persona)),
    renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
    renderPromptSection("reply_rules", buildReplyRuleLines()),
    renderPromptSection("memory_write_decision", buildMemoryRuleLines()),
    renderPromptSection("context_rules", buildContextRuleLines({
      visibleToolNames: input.visibleToolNames
    })),
    renderPromptSection("tool_hints", buildToolHintLines(input.visibleToolNames)),
    renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
      activeToolsets: input.activeToolsets,
      visibleToolNames: input.visibleToolNames
    })),
    renderPromptSection("live_resources", buildLiveResourceLines(input.liveResources)),
    renderPromptSection("participant_context", [
      ...buildParticipantContextLines(input.sessionMode, input.participantProfiles),
      ...buildNpcContextLines(input.sessionMode, input.npcProfiles, input.participantProfiles)
    ]),
    renderPromptSection("history_summary", buildHistorySummaryLines(input.historySummary)),
    renderPromptSection("global_rules", buildGlobalRuleLines(preparedMemoryContext.globalRules)),
    renderPromptSection("toolset_rules", buildToolsetRuleLines(preparedMemoryContext.toolsetRules)),
    renderPromptSection("current_user_profile", buildCurrentUserProfileLines({
      userProfile: input.userProfile,
      userMemories: preparedMemoryContext.userMemories
    })),
    renderPromptSection("current_user_memories", buildCurrentUserMemoryLines(preparedMemoryContext.userMemories))
  ].filter((item): item is string => Boolean(item));
}

function buildAssistantIdentityLines(): string[] {
  return [
    "你当前以 AI assistant 模式工作，优先直接理解并完成用户请求。",
    "以全局 persona 作为稳定的人格与口吻底座，但不要把对话强行演成角色扮演，也不要额外编造关系、剧情或只属于 RP 的设定。"
  ];
}

function buildScenarioHostIdentityLines(): string[] {
  return [
    "你当前是剧情主持模式下的场景主持者，负责描述环境、推进事件、控制非玩家角色，并回应玩家行动。",
    "默认用中文主持，不要把自己当成普通陪聊助手，也不要回到 RP 助手的人设口吻。"
  ];
}

function buildRpAssistantIdentityLines(): string[] {
  return [
    "你当前处于 RP assistant 模式，应以真人角色身份自然互动。",
    "全局 persona 是你的长期人格底座；下面的 RP 全局资料是在此基础上的模式补充，必须一起遵守。",
    "不要把自己说成模型、系统或普通助手；也不要跳出 RP 身份解释内部机制。"
  ];
}

function buildScenarioHostRuleLines(): string[] {
  return [
    "`*` 开头表示玩家动作声明；先按动作已经发生来主持结果。",
    "`#` 开头表示场外指令或提问；不要把它写进剧情，也不要当成角色行为。",
    "无前缀文本默认视为玩家角色对白；先按对白已经说出口来描述场面反馈。",
    "先用叙事语气落地玩家刚刚声明的动作或对白已经发生，再推进环境变化、事件反应或非玩家角色回应。",
    "不要代替玩家决定、行动、说话或描写其内心；除非玩家明确要求，否则你只操作环境、事件和非玩家角色。",
    "单轮只做小步推进；优先描述眼前直接结果，不要连续跳过多个关键行动或过快推进剧情。",
    "每轮都要给出可继续互动的场景反馈；若暂时无法推进，要明确说明阻碍。",
    "保持轻规则主持；可以给出合理成败与代价，但不要引入复杂数值、骰点或长规则讲解。",
    "不要在段落结尾反问玩家下一步要做什么，也不要默认列出可选行动让玩家选择。",
    "不要把内部状态字段原样罗列给玩家，除非玩家明确要求查看总结或清单。",
    "当前版本只服务单主玩家私聊场景。"
  ];
}

function buildRpProfileDraftModeLines(
  profile: RpProfile,
  missingFields: EditableRpProfileFieldName[],
  phase: "setup" | "config"
): string[] {
  const missingSet = new Set(missingFields);
  const coreMissingFields = getMissingRpProfileFields(profile);
  const coreMissingSet = new Set(coreMissingFields);
  const filledLabels = editableRpProfileFieldNames
    .filter((field) => !missingSet.has(field) && profile[field]?.trim())
    .map((field) => rpProfileFieldLabels[field]);
  const coreMissingLabels = coreMissingFields.map((field) => rpProfileFieldLabels[field]);
  const optionalMissingLabels = editableRpProfileFieldNames
    .filter((field) => !coreMissingSet.has(field) && missingSet.has(field))
    .map((field) => rpProfileFieldLabels[field]);

  if (phase === "config") {
    return [
      "当前处于 RP 全局资料配置阶段，你正在编辑一份基于已保存 RP 资料复制出的临时草稿。",
      filledLabels.length > 0
        ? `当前草稿已明确：${filledLabels.join("、")}。`
        : "当前 RP 草稿仍接近空白，可按 owner 的要求逐步补齐。",
      coreMissingLabels.length > 0
        ? `核心字段仍缺：${coreMissingLabels.join("、")}；若 owner 本轮没有指定更高优先级目标，先补这些。`
        : "当前核心字段已完整，优先按 owner 本轮明确要求做局部调整。",
      optionalMissingLabels.length > 0
        ? `可在需要时继续补充：${optionalMissingLabels.join("、")}。`
        : "可选补充字段已齐全，除非 owner 明确要求，否则不要重问整份 RP 资料。",
      "RP 资料只在全局 persona 底座上补充真人化设定；不要把 persona 内容重复写入 RP 资料，也不要写到用户资料或其他长期记忆。",
      "若本轮只是微调单个字段，就直接改那一项；只有遇到核心字段缺失、语义冲突或边界不清时再追问。",
      "如需核对现状，优先概括或发送当前 RP 草稿；草稿发出后等待 owner 反馈，不要在同一回复继续追问新的长串字段。",
      "回复保持短句纯文本，不用 Markdown 标题或列表。"
    ];
  }

  if (coreMissingLabels.length === 9) {
    return [
      "当前处于 RP 全局资料初始化阶段，需要从空白草稿开始建立 RP 专用资料。",
      "先确认这个人在 RP 中如何看待自己，以及他在现实中的社会角色；不要一上来把整份问卷全抛给 owner。",
      "RP 资料只服务 RP 模式；不要修改 persona、用户资料、关系或其他长期记忆。",
      "owner 每提供一段明确设定，就立即用工具写入草稿；不要等所有信息都收集完再统一写入。",
      "核心字段初步成形后，调用 send_setup_draft 发送当前 RP 草稿供 owner 核对。",
      "回复保持短句纯文本，不用 Markdown 标题或列表。"
    ];
  }

  if (coreMissingLabels.length > 0) {
    return [
      `当前 RP 草稿已有部分内容，但核心字段仍缺：${coreMissingLabels.join("、")}。`,
      `当前优先确认：${coreMissingLabels[0]}；其余核心字段可在同一主题下顺势补齐。`,
      "RP 资料只服务 RP 模式；不要修改 persona、用户资料、关系或其他长期记忆。",
      "owner 每提供一段明确设定，就立即用工具写入草稿；不要等所有信息都收集完再统一写入。",
      "核心字段补得足够稳定后，调用 send_setup_draft 发送当前 RP 草稿供 owner 核对。",
      "回复保持短句纯文本，不用 Markdown 标题或列表。"
    ];
  }

  return [
    "RP 核心字段已完成，可继续补充连续性事实等辅助信息。",
    "只补 owner 明确提供或明确同意补充的内容；不要因为是 setup 就强行追问所有可选字段。",
    "补充信息稳定后，调用 send_setup_draft 发送当前 RP 草稿供 owner 核对。",
    "回复保持短句纯文本，不用 Markdown 标题或列表。"
  ];
}

function buildScenarioProfileDraftModeLines(
  profile: ScenarioProfile,
  missingFields: EditableScenarioProfileFieldName[],
  phase: "setup" | "config"
): string[] {
  const missingSet = new Set(missingFields);
  const coreMissingFields = getMissingScenarioProfileFields(profile);
  const coreMissingSet = new Set(coreMissingFields);
  const filledLabels = editableScenarioProfileFieldNames
    .filter((field) => !missingSet.has(field) && profile[field]?.trim())
    .map((field) => scenarioProfileFieldLabels[field]);
  const coreMissingLabels = coreMissingFields.map((field) => scenarioProfileFieldLabels[field]);
  const optionalMissingLabels = editableScenarioProfileFieldNames
    .filter((field) => !coreMissingSet.has(field) && missingSet.has(field))
    .map((field) => scenarioProfileFieldLabels[field]);

  if (phase === "config") {
    return [
      "当前处于 Scenario 全局资料配置阶段，你正在编辑一份基于已保存 Scenario 资料复制出的临时草稿。",
      filledLabels.length > 0
        ? `当前草稿已明确：${filledLabels.join("、")}。`
        : "当前 Scenario 草稿仍接近空白，可按 owner 的要求逐步补齐。",
      coreMissingLabels.length > 0
        ? `核心字段仍缺：${coreMissingLabels.join("、")}；若 owner 本轮没有指定更高优先级目标，先补这些。`
        : "当前核心字段已完整，优先按 owner 本轮明确要求做局部调整。",
      optionalMissingLabels.length > 0
        ? `可在需要时继续补充：${optionalMissingLabels.join("、")}。`
        : "可选补充字段已齐全，除非 owner 明确要求，否则不要重问整份 Scenario 资料。",
      "Scenario 资料只服务 scenario_host 模式；它是在全局 persona 底座上的主持补充，不要改写 persona 或用户资料。",
      "若本轮只是微调单个字段，就直接改那一项；只有遇到核心字段缺失、语义冲突或主持边界不清时再追问。",
      "如需核对现状，优先概括或发送当前 Scenario 草稿；草稿发出后等待 owner 反馈，不要在同一回复继续追问新的长串字段。",
      "回复保持短句纯文本，不用 Markdown 标题或列表。"
    ];
  }

  if (coreMissingLabels.length === 3) {
    return [
      "当前处于 Scenario 全局资料初始化阶段，需要从空白草稿开始建立主持所需的长期资料。",
      "先用 1-2 个紧密相关的问题补齐主题和世界基线，再继续确认主持风格；不要一上来要求 owner 把整套设定一次说完。",
      "Scenario 资料只服务 scenario_host 模式；不要修改 persona、用户资料、关系或其他长期记忆。",
      "owner 每提供一段明确设定，就立即用工具写入草稿；不要等所有信息都收集完再统一写入。",
      "核心字段初步成形后，调用 send_setup_draft 发送当前 Scenario 草稿供 owner 核对。",
      "回复保持短句纯文本，不用 Markdown 标题或列表。"
    ];
  }

  if (coreMissingLabels.length > 0) {
    return [
      `当前 Scenario 草稿已有部分内容，但核心字段仍缺：${coreMissingLabels.join("、")}。`,
      `当前优先确认：${coreMissingLabels[0]}；其余核心字段可在同一主题下顺势补齐。`,
      "Scenario 资料只服务 scenario_host 模式；不要修改 persona、用户资料、关系或其他长期记忆。",
      "owner 每提供一段明确设定，就立即用工具写入草稿；不要等所有信息都收集完再统一写入。",
      "核心字段补得足够稳定后，调用 send_setup_draft 发送当前 Scenario 草稿供 owner 核对。",
      "回复保持短句纯文本，不用 Markdown 标题或列表。"
    ];
  }

  return [
    "Scenario 核心字段已完成，可继续补充安全/禁忌规则、开场模式等辅助信息。",
    "只补 owner 明确提供或明确同意补充的内容；不要因为是 setup 就强行追问所有可选字段。",
    "补充信息稳定后，调用 send_setup_draft 发送当前 Scenario 草稿供 owner 核对。",
    "回复保持短句纯文本，不用 Markdown 标题或列表。"
  ];
}

function buildScenarioHostSetupModeLines(): string[] {
  return [
    "当前处于场景初始化阶段，故事基础信息尚未设定。",
    "你的目标是与玩家一来一回地逐步收集场景设定，不要要求玩家一次性填完所有内容。",
    "优先询问并收集以下核心信息（可分多轮）：",
    "- 场景标题（title）：这是什么故事？",
    "- 当前情况（currentSituation）：故事从哪里开始，玩家当前在哪、面对什么？",
    "- 玩家角色（currentSituation 中提及即可，或另外补充）",
    "每当玩家提供信息后，立即调用对应工具写入已确认的字段（update_scenario_state 或 set_current_location），不要等所有字段都收集完。",
    "收集到核心信息后，调用 send_setup_draft 将当前场景设定以格式化草稿发送给玩家核对；不要在回复正文中逐条列出字段。",
    "草稿发出后，告知玩家如果满意可以输入 .confirm 完成初始化，如有修改继续告诉你即可。",
    "不要在回复正文中输出 .confirm；.confirm 只能由玩家自己输入，不可由你代替输出。",
    "初始化完成前不要进行任何剧情推进；只收集信息、写入状态、发送草稿。",
    "回复保持简洁，不用 Markdown 标题或列表。"
  ];
}

export function buildScheduledTaskSystemLines(input: {
  trigger:
    | {
        kind: "scheduled_instruction";
        jobName: string;
        taskInstruction: string;
      }
    | {
        kind: "comfy_task_completed";
        jobName: string;
        taskInstruction: string;
        taskId: string;
        templateId: string;
        positivePrompt: string;
        aspectRatio: string;
        resolvedWidth: number;
        resolvedHeight: number;
        workspaceFileIds: string[];
        chatFilePaths: string[];
        comfyPromptId: string;
        autoIterationIndex: number;
        maxAutoIterations: number;
      }
    | {
        kind: "comfy_task_failed";
        jobName: string;
        taskInstruction: string;
        taskId: string;
        templateId: string;
        positivePrompt: string;
        aspectRatio: string;
        resolvedWidth: number;
        resolvedHeight: number;
        comfyPromptId: string;
        lastError: string;
        autoIterationIndex: number;
        maxAutoIterations: number;
      };
  targetContext:
    | {
        chatType: "private";
        userId: string;
        senderName: string;
      }
    | {
        chatType: "group";
        groupId: string;
      };
}): string[] {
  if (input.trigger.kind === "scheduled_instruction") {
    return [
      renderPromptSection("scheduled_task", [
        "下面这次执行是内部计划任务，不是用户刚刚发来了一条新消息。",
        "先根据任务指令和已有上下文决定是否需要查资料、看图、调用工具或给目标会话发消息。",
        "如果最终需要发消息，只产出要发送给目标会话的一条自然消息，不要带系统播报腔。"
      ])
    ].filter((item): item is string => Boolean(item));
  }

  if (input.trigger.kind === "comfy_task_completed") {
    return [
      renderPromptSection("comfy_task_completed", [
        "下面这次执行是图片生成完成后的内部回调，不是用户刚刚发来了一条新消息。",
        "你之前发起的图片生成任务已经完成，结果已导入 workspace。",
        "如果还没看图，不要假装已经看过；需要判断细节时先看图，再决定是发图、重试还是简短说明。"
      ])
    ].filter((item): item is string => Boolean(item));
  }

  return [
    renderPromptSection("comfy_task_failed", [
      "下面这次执行是图片生成失败后的内部回调，不是用户刚刚发来了一条新消息。",
      "你之前发起的图片生成任务失败了；先判断是直接重试还是向用户简短说明。"
    ])
  ].filter((item): item is string => Boolean(item));
}

function buildModeProfilePersonaBaseLines(persona: Persona, modeLabel: "RP" | "Scenario"): string[] {
  return [
    `以下全局 persona 是当前实例在所有模式下共享的底座；当前 ${modeLabel} 资料只是建立在这层基础上的模式补充。`,
    ...buildSharedPersonaSummaryLines(persona),
    `不要把已属于 persona 的内容重复搬进 ${modeLabel} 资料，也不要在这里修改 persona 本身。`
  ];
}

function buildSharedPersonaLines(persona: Persona): string[] {
  return [
    "以下全局 persona 在所有模式下都生效，是当前实例共享的人格与基础身份底座。",
    ...buildSharedPersonaSummaryLines(persona)
  ];
}

function buildSharedPersonaSummaryLines(persona: Persona): string[] {
  const personaSummary = [
    `名字=${persona.name}`,
    `性格底色=${persona.temperament}`,
    `说话方式=${persona.speakingStyle}`
  ].join("；");
  const extraFacts = [
    persona.globalTraits ? `全局特征=${persona.globalTraits}` : null,
    persona.generalPreferences ? `通用偏好=${persona.generalPreferences}` : null
  ].filter((item): item is string => Boolean(item));

  return [
    `全局 persona：${personaSummary}`,
    ...(extraFacts.length > 0 ? [`全局补充设定：${extraFacts.join("；")}`] : [])
  ];
}

function buildRpProfileLines(profile: RpProfile): string[] {
  return buildModeProfileSummaryLines({
    intro: "以下 RP 全局资料只在 rp_assistant 模式下生效，是建立在全局 persona 之上的真人化补充。",
    label: "RP 全局资料",
    coreParts: [
      profile.selfPositioning ? `自我定位=${profile.selfPositioning}` : null,
      profile.socialRole ? `社会角色=${profile.socialRole}` : null,
      profile.lifeContext ? `生活状态=${profile.lifeContext}` : null,
      profile.physicalPresence ? `外在存在感=${profile.physicalPresence}` : null,
      profile.bondToUser ? `与用户关系=${profile.bondToUser}` : null,
      profile.closenessPattern ? `亲密模式=${profile.closenessPattern}` : null,
      profile.interactionPattern ? `互动模式=${profile.interactionPattern}` : null,
      profile.realityContract ? `现实契约=${profile.realityContract}` : null,
      profile.hardLimits ? `硬边界=${profile.hardLimits}` : null
    ],
    extraParts: [
      profile.continuityFacts ? `连续性事实=${profile.continuityFacts}` : null
    ]
  });
}

function buildScenarioProfileLines(profile: ScenarioProfile): string[] {
  return buildModeProfileSummaryLines({
    intro: "以下 Scenario 全局资料只在 scenario_host 模式下生效，是建立在全局 persona 之上的主持补充。",
    label: "Scenario 全局资料",
    coreParts: [
      profile.theme ? `主题=${profile.theme}` : null,
      profile.hostStyle ? `主持风格=${profile.hostStyle}` : null,
      profile.worldBaseline ? `世界基线=${profile.worldBaseline}` : null
    ],
    extraParts: [
      profile.safetyOrTabooRules ? `安全/禁忌规则=${profile.safetyOrTabooRules}` : null,
      profile.openingPattern ? `开场模式=${profile.openingPattern}` : null
    ]
  });
}

function buildModeProfileSummaryLines(input: {
  intro: string;
  label: string;
  coreParts: Array<string | null>;
  extraParts: Array<string | null>;
}): string[] {
  const coreParts = input.coreParts.filter((item): item is string => Boolean(item));
  const extraParts = input.extraParts.filter((item): item is string => Boolean(item));

  return [
    input.intro,
    coreParts.length > 0 ? `${input.label}：${coreParts.join("；")}` : `${input.label}：当前仍接近空白。`,
    ...(extraParts.length > 0 ? [`模式补充：${extraParts.join("；")}`] : [])
  ];
}

function buildDraftWorkflowLines(input: {
  targetLabel: string;
  phase: "setup" | "config";
  allowSkipOptionalFields?: boolean | undefined;
}): string[] {
  return [
    `你当前只在${input.targetLabel}的临时草稿上工作；除非 owner 输入 .confirm，否则任何改动都不会写回正式配置。`,
    "当前配置流程处理的是 bot 自身的设定草稿。owner 在这里用第一人称提供的信息，默认是在描述 bot，而不是在填写 owner 自己的资料。",
    "与 owner 互动时保持主动、友好、helpful 的引导感，像在陪对方一步步完成设定；但仍要保持简洁，不要堆成长篇说明。",
    "如果 owner 输入 .cancel，应视为放弃本轮草稿并回到进入配置前的已保存状态。",
    "每轮只推进最关键的一步：要么写入刚确认的信息，要么追问 1-2 个紧密相关的缺口，要么发送草稿供核对。",
    input.phase === "setup"
      ? `调用 send_setup_draft 后，只需简短告知 owner 满意可输入 .confirm 完成初始化；不要在同一回复继续追问新的长串字段。`
      : `调用 send_setup_draft 后，只需简短告知 owner 满意可输入 .confirm 保存，不满意可继续修改或 .cancel 放弃；不要在同一回复继续追问新的长串字段。`,
    input.allowSkipOptionalFields
      ? "如果 owner 明确跳过某些可选字段，可以先继续后面的配置，不要强行补问。"
      : "如果 owner 暂时不想补可选字段，就先保留为空，不要为了凑完整度强行追问。"
  ];
}

function buildRpProfileSnapshotLines(
  profile: RpProfile,
  missingFields: EditableRpProfileFieldName[]
): string[] {
  return buildProfileSnapshotLines({
    fieldNames: editableRpProfileFieldNames,
    fieldLabels: rpProfileFieldLabels,
    fieldHints: RP_PROFILE_FIELD_HINTS,
    profile,
    missingFields
  });
}

function buildScenarioProfileSnapshotLines(
  profile: ScenarioProfile,
  missingFields: EditableScenarioProfileFieldName[]
): string[] {
  return buildProfileSnapshotLines({
    fieldNames: editableScenarioProfileFieldNames,
    fieldLabels: scenarioProfileFieldLabels,
    fieldHints: SCENARIO_PROFILE_FIELD_HINTS,
    profile,
    missingFields
  });
}

function buildProfileSnapshotLines<FieldName extends string>(input: {
  fieldNames: readonly FieldName[];
  fieldLabels: Record<FieldName, string>;
  fieldHints: Record<FieldName, string>;
  profile: Record<FieldName, string>;
  missingFields: readonly FieldName[];
}): string[] {
  const missingSet = new Set(input.missingFields);
  const filledParts = input.fieldNames
    .filter((field) => !missingSet.has(field) && input.profile[field]?.trim())
    .map((field) => `${input.fieldLabels[field]}=${input.profile[field]}`);
  const missingParts = input.missingFields.map((field) =>
    `- ${input.fieldLabels[field]}：${input.fieldHints[field]}`
  );

  return [
    ...(filledParts.length > 0 ? [`已设定：${filledParts.join("；")}`] : []),
    ...(missingParts.length > 0 ? [`待补全：\n${missingParts.join("\n")}`] : [])
  ];
}

function buildReplyRuleLines(): string[] {
  return [
    "默认短答；能一句说清就一句。只有用户明确要求分析、对比、步骤或长说明，或不展开会遗漏必要信息时再多说。",
    "对方若没有明确问题、请求、任务或待确认事项，只需自然收住，不要机械续聊。",
    "若当前触发用户是 NPC/bot，只在确有协作、提问、转达或必要确认时继续回复。"
  ];
}

function buildMemoryRuleLines(): string[] {
  return [
    "长期信息写入决策树：",
    "1. bot 的名字、性格底色、说话方式、跨模式全局偏好 -> persona。",
    "2. owner 级、跨任务长期工作流偏好 -> global_rules。",
    "3. 只在某个工具集或工作流里生效的长期规则 -> toolset_rules。",
    "4. 稳定且结构化的用户卡片信息 -> user_profile。",
    "5. 其余长期用户偏好、边界、习惯、关系背景或事实 -> user_memories。",
    "6. 只对当前任务/当前轮有效，或语义不确定 -> 不写长期信息。",
    "优先更新已有相近条目，不要把同一事实同时写进多个类别。",
    "用户本人明确自述的可信度高于推断；弱推断默认不写。",
    "如果回复里说了“记下了”“以后按这个来”“已经写进 persona”，本轮之前必须已经实际完成对应写入。"
  ];
}

function buildContextRuleLines(input: { visibleToolNames?: string[] | undefined }): string[] {
  const lines = [
    "批次头和每条消息头只用于帮助你分清会话模式、当前触发用户和具体发言者；不要在最终回复里复述这些头。",
    "遇到结构化引用时先按引用理解上下文，不要脑补隐藏内容。"
  ];
  if ((input.visibleToolNames ?? []).includes("request_toolset")) {
    lines.push("当前工具按工具集分批暴露；若发现缺少完成任务所需能力，先查看可申请的工具集，再申请补充。");
  }
  lines.push("工具报错时先调整参数、改走正确路径或换用更合适的能力；只有确实无法完成时再简短说明。");
  return lines;
}

function buildDisclosureLines(interactionMode: PromptInteractionMode | undefined): string[] {
  if (interactionMode === "debug") {
    return [
      "当前会话已进入 owner 调试模式。你可以直接说明内部工作过程，包括工具名、调用原因、调用结果、失败原因、系统约束、后端编排和能力边界。",
      "在调试模式下，优先准确、可审计；需要时可以明确区分哪些是直接获取到的事实，哪些是推断或仍未确认的部分。"
    ];
  }

  return [
    "你可以使用系统提供的能力完成任务，但这些都属于内部工作过程。除非当前明确处于调试模式，否则对用户只描述你完成了什么，不要提工具名、函数调用、提示词、系统消息、后端流程、权限规则、会话编排、计划任务框架或内部 API。",
    "如果用户追问你是怎么做到的，在非调试模式下也只用用户视角表述，例如“我查了一下资料”“我看了图片和记录”“我确认了上下文”；不要承认任何工具存在。"
  ];
}

function formatRelationshipLabel(relationship?: PromptInput["userProfile"]["relationship"]): string {
  if (relationship === "owner") return "主人";
  if (relationship === "known") return "熟人";
  return "未建档";
}

function isNearDuplicate(source: string, candidates: string[]): boolean {
  return isNearDuplicateText(source, candidates, MEMORY_SIMILARITY_THRESHOLD);
}

function splitProfileSummaryClauses(summary: string): string[] {
  return summary
    .split(/[；;。！？!?]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeProfileSummaryAgainstMemories(
  profileSummary: string | undefined,
  memoryCandidates: string[]
): string | undefined {
  const compactSummary = normalizeProfileSummary(profileSummary);
  if (!compactSummary) {
    return undefined;
  }
  const visibleClauses = splitProfileSummaryClauses(compactSummary)
    .filter((clause) => !isNearDuplicate(clause, memoryCandidates));
  if (visibleClauses.length === 0) {
    return undefined;
  }
  return normalizeProfileSummary(visibleClauses.join("；"));
}

function buildPersonaCandidateTexts(persona: Persona): string[] {
  return [
    persona.name,
    persona.temperament,
    persona.speakingStyle,
    persona.globalTraits,
    persona.generalPreferences,
  ].filter((item): item is string => Boolean(item));
}

function formatEntryLines(entries: Array<{ title: string; content: string }> | undefined): string {
  if (!entries || entries.length === 0) return "";
  return entries
    .slice(0, MAX_VISIBLE_MEMORIES)
    .map((item) => `- ${item.title}：${item.content}`)
    .join("\n");
}

function partitionPromptMemoryItems<T extends SuppressiblePromptMemoryItem>(
  items: T[] | undefined,
  category: PromptMemorySuppression["category"],
  higherPriorityCandidates: string[]
): {
  visible: T[];
  suppressed: PromptMemorySuppression[];
} {
  const visible: T[] = [];
  const suppressed: PromptMemorySuppression[] = [];
  for (const item of items ?? []) {
    if (isNearDuplicate(`${item.title} ${item.content}`, higherPriorityCandidates)) {
      suppressed.push({
        category,
        itemId: item.id ?? null,
        title: item.title,
        reason: "near_duplicate_higher_priority"
      });
      continue;
    }
    visible.push(item);
  }
  return { visible, suppressed };
}

export function preparePromptMemoryContext(input: {
  persona: Persona;
  globalRules?: GlobalRuleEntry[] | undefined;
  toolsetRules?: ToolsetRuleEntry[] | undefined;
  userProfile: PromptInput["userProfile"];
  userMemories?: UserMemoryEntry[] | undefined;
}): PreparedPromptMemoryContext {
  const personaCandidates = buildPersonaCandidateTexts(input.persona);
  const globalPartition = partitionPromptMemoryItems(
    input.globalRules,
    "global_rules",
    personaCandidates
  );
  const toolsetPartition = partitionPromptMemoryItems(
    input.toolsetRules,
    "toolset_rules",
    [
      ...personaCandidates,
      ...globalPartition.visible.map((item) => `${item.title} ${item.content}`)
    ]
  );
  const profileCandidates = [
    input.userProfile.preferredAddress,
    input.userProfile.gender,
    input.userProfile.residence,
    input.userProfile.timezone,
    input.userProfile.occupation,
    input.userProfile.profileSummary,
    input.userProfile.relationshipNote
  ].filter((item): item is string => Boolean(item));
  const userMemoryPartition = partitionPromptMemoryItems(
    input.userMemories,
    "user_memories",
    [
      ...personaCandidates,
      ...globalPartition.visible.map((item) => `${item.title} ${item.content}`),
      ...toolsetPartition.visible.map((item) => `${item.title} ${item.content}`),
      ...profileCandidates
    ]
  );
  return {
    globalRules: globalPartition.visible,
    toolsetRules: toolsetPartition.visible,
    userMemories: userMemoryPartition.visible
      .slice()
      .sort((left, right) => scoreUserMemory(right) - scoreUserMemory(left)),
    suppressions: [
      ...globalPartition.suppressed,
      ...toolsetPartition.suppressed,
      ...userMemoryPartition.suppressed
    ]
  };
}

function scoreUserMemory(memory: UserMemoryEntry): number {
  const kindWeight = ({
    boundary: 5,
    preference: 4.5,
    relationship: 4,
    habit: 3,
    fact: 2,
    other: 1
  } satisfies Record<UserMemoryEntry["kind"], number>)[memory.kind];
  const importanceWeight = memory.importance ?? 0;
  const lastUsedWeight = memory.lastUsedAt ? Math.max(0.5, 2 - ((Date.now() - memory.lastUsedAt) / (30 * 24 * 60 * 60 * 1000))) : 0;
  const recencyWeight = Math.max(0, 2 - ((Date.now() - memory.updatedAt) / (45 * 24 * 60 * 60 * 1000)));
  return kindWeight + importanceWeight + lastUsedWeight + recencyWeight;
}

function formatCompactProfile(item: {
  displayName: string;
  userId: string;
  relationshipLabel?: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  timezone?: string;
  occupation?: string;
  profileSummary?: string;
  relationshipNote?: string;
}): string {
  const compactSummary = normalizeProfileSummary(item.profileSummary);
  return [
    `${item.displayName} (${item.userId})`,
    item.relationshipLabel ? `关系=${item.relationshipLabel}` : null,
    item.preferredAddress ? `称呼=${item.preferredAddress}` : null,
    item.gender ? `性别=${item.gender}` : null,
    item.residence ? `住地=${item.residence}` : null,
    item.timezone ? `时区=${item.timezone}` : null,
    item.occupation ? `职业=${item.occupation}` : null,
    compactSummary ? `画像=${compactSummary}` : null,
    item.relationshipNote ? `关系背景=${item.relationshipNote}` : null
  ].filter(Boolean).join("；");
}

function buildParticipantContextLines(
  sessionMode: "private" | "group" | "unknown",
  participantProfiles: PromptParticipantProfile[]
): string[] {
  if (sessionMode !== "group") {
    return [];
  }
  const visibleParticipants = participantProfiles
    .slice()
    .sort((left, right) => left.userId.localeCompare(right.userId))
    .slice(0, MAX_VISIBLE_PARTICIPANTS);
  return visibleParticipants.length > 0
    ? [`当前相关用户：\n${visibleParticipants.map((item) => `- ${formatCompactProfile(item)}`).join("\n")}`]
    : [];
}

function buildNpcContextLines(
  sessionMode: "private" | "group" | "unknown",
  npcProfiles: PromptNpcProfile[],
  participantProfiles: PromptParticipantProfile[]
): string[] {
  if (sessionMode !== "group") {
    return [];
  }
  const participantIds = new Set(participantProfiles.map((item) => item.userId));
  const relevantNpcs = npcProfiles
    .filter((item) => participantIds.has(item.userId))
    .slice()
    .sort((left, right) => left.userId.localeCompare(right.userId))
    .slice(0, MAX_VISIBLE_NPCS);
  return relevantNpcs.length > 0
    ? [`当前相关 NPC：\n${relevantNpcs.map((item) => `- ${formatCompactProfile(item)}`).join("\n")}`]
    : [];
}

function buildHistorySummaryLines(historySummary?: string | null | undefined): string[] {
  return historySummary ? [`较早历史摘要：${historySummary}`] : [];
}

function buildLiveResourceLines(resources: PromptLiveResource[] | undefined): string[] {
  if (!resources || resources.length === 0) {
    return [];
  }
  const visible = resources.filter((item) => item.status === "active");
  if (visible.length === 0) {
    return [];
  }
  const lines = visible.map((item) => {
    const kind = item.kind === "browser_page" ? "browser" : "shell";
    const title = item.title?.trim() ? ` | ${item.title.trim()}` : "";
    const description = item.description?.trim() ? ` | ${item.description.trim()}` : "";
    return `- ${item.resourceId} | ${kind} | ${item.status}${title}${description} | ${item.summary}`;
  });
  return [`当前可复用 live_resource（需要继续操作网页/终端时优先复用这些 resource_id）：\n${lines.join("\n")}`];
}

function buildToolsetRuleLines(rules: ToolsetRuleEntry[] | undefined): string[] {
  if (!rules || rules.length === 0) {
    return [];
  }
  return [`当前激活工具集相关长期规则（最多 ${MAX_VISIBLE_MEMORIES} 条）：\n${formatEntryLines(rules)}`];
}

function buildGlobalRuleLines(entries: GlobalRuleEntry[]): string[] {
  const ruleText = formatEntryLines(
    entries
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
  );
  return ruleText ? [`当前长期全局行为规则（最多 ${MAX_VISIBLE_MEMORIES} 条）：\n${ruleText}`] : [];
}

function buildCurrentUserProfileLines(input: {
  userProfile: PromptInput["userProfile"];
  userMemories: UserMemoryEntry[];
}): string[] {
  const memoryCandidates = input.userMemories.map((item) => `${item.title} ${item.content}`);
  const compactSummary = dedupeProfileSummaryAgainstMemories(input.userProfile.profileSummary, memoryCandidates);
  const core = [
    `当前触发用户：${input.userProfile.senderName ?? "未知"} (${input.userProfile.userId ?? "未知"})`,
    `当前触发用户关系：${formatRelationshipLabel(input.userProfile.relationship)}${input.userProfile.specialRole ? `；特殊角色=${input.userProfile.specialRole}` : ""}`
  ];
  const extra = [
    input.userProfile.preferredAddress ? `偏好称呼=${input.userProfile.preferredAddress}` : null,
    input.userProfile.gender ? `性别=${input.userProfile.gender}` : null,
    input.userProfile.residence ? `住地=${input.userProfile.residence}` : null,
    input.userProfile.timezone ? `时区=${input.userProfile.timezone}` : null,
    input.userProfile.occupation ? `职业=${input.userProfile.occupation}` : null,
    compactSummary ? `用户画像=${compactSummary}` : null,
    input.userProfile.relationshipNote ? `关系背景=${input.userProfile.relationshipNote}` : null
  ].filter((item): item is string => Boolean(item));

  return [
    ...core,
    ...(extra.length > 0 ? [`当前触发用户补充资料：${extra.join("；")}`] : []),
    ...(input.userProfile.specialRole === "npc" ? ["当前触发用户是 NPC/bot；把这轮优先当成协作或任务沟通。"] : [])
  ];
}

function buildCurrentUserMemoryLines(memories: UserMemoryEntry[] | undefined): string[] {
  const memoryText = formatEntryLines(memories);
  return memoryText ? [`当前触发用户长期记忆（最多 ${MAX_VISIBLE_MEMORIES} 条）：\n${memoryText}`] : [];
}

function buildToolsetGuidanceLines(input: {
  activeToolsets?: ToolsetView[] | undefined;
  visibleToolNames?: string[] | undefined;
}): string[] {
  const lines: string[] = [];
  const activeToolsets = input.activeToolsets ?? [];
  if (activeToolsets.length > 0) {
    lines.push(`当前激活工具集：${activeToolsets.map((item) => item.title).join("、")}`);
  }
  if ((input.visibleToolNames ?? []).includes("request_toolset")) {
    lines.push("若当前激活工具集不够完成任务，可先查看可申请的工具集，再申请补充。");
  }
  return lines;
}

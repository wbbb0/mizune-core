import type { GlobalRuleEntry } from "#memory/globalRuleEntry.ts";
import type { UserMemoryEntry } from "#memory/userMemoryEntry.ts";
import { editablePersonaFieldNames, personaFieldLabels, type EditablePersonaFieldName, type Persona } from "#persona/personaSchema.ts";
import type {
  PromptInput,
  PromptInteractionMode,
  PromptLiveResource,
  PromptNpcProfile,
  PromptParticipantProfile,
  PromptToolEvent
} from "#llm/prompt/promptTypes.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { renderPromptSection } from "./prompt-section.ts";
import { isNearDuplicateText } from "#memory/similarity.ts";
import type { ToolsetRuleEntry } from "#llm/prompt/toolsetRuleStore.ts";
import { normalizeProfileSummary } from "#identity/userProfile.ts";

const PERSONA_FIELD_HINTS: Record<EditablePersonaFieldName, string> = {
  name: "角色的名字",
  role: "身份与基本设定，一两句话",
  personality: "性格关键词，可多个",
  speechStyle: "语气与说话习惯",
  appearance: '外貌特征；或填"不设定"',
  interests: "兴趣爱好与喜好禁忌",
  background: "背景故事、家庭、住处等，可简短",
  rules: '特殊边界或长期要求；如无则填"无特殊限制"'
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
  missingFields: EditablePersonaFieldName[];
}): string[] {
  return [
    renderPromptSection("setup_mode", buildSetupModeLines(input.persona, input.missingFields)),
    renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
    renderPromptSection("persona_snapshot", buildSetupSnapshotLines(input.persona, input.missingFields))
  ].filter((item): item is string => Boolean(item));
}

function buildSetupModeLines(persona: Persona, missingFields: EditablePersonaFieldName[]): string[] {
  const missingSet = new Set(missingFields);
  const totalMissing = missingFields.length;
  const coreComplete = !missingSet.has("name") && !missingSet.has("role");

  const identityRef = coreComplete
    ? `"${persona.name}"（${persona.role}）`
    : persona.name ? `"${persona.name}"` : null;

  const phaseLines: string[] = [];

  if (totalMissing === 0) {
    phaseLines.push(`角色 ${identityRef ?? "persona"} 所有字段已填写完毕。`);
    phaseLines.push("调用 send_setup_draft 向 owner 发送完整设定草稿供最终确认。");
    phaseLines.push("发送草稿后，告知 owner 如果没有问题可以输入 .confirm 完成初始化，如有修改继续告诉你。");
  } else if (!coreComplete && totalMissing === 8) {
    phaseLines.push("当前实例处于初始化阶段，需要帮 owner 完成角色 persona 设定。");
    phaseLines.push("简要告知 owner：正在设定角色人设，完成后即可正常聊天；然后从名字和角色定位开始询问。");
  } else if (!coreComplete) {
    const nextCore = missingSet.has("name") ? "名字" : "角色定位";
    const alreadyHave = identityRef ? `已知角色名为 ${identityRef}，` : "";
    phaseLines.push(`当前处于初始化阶段，${alreadyHave}核心设定未完成，当前优先询问：${nextCore}。`);
  } else {
    const remainingLabels = missingFields.map((f) => personaFieldLabels[f]).join("、");
    phaseLines.push(`角色 ${identityRef} 的核心设定已完成，还需补充：${remainingLabels}。`);
    phaseLines.push("可以一次询问多个字段，允许 owner 简短回答或跳过某些字段。");
  }

  return [
    ...phaseLines,
    "owner 提供信息后，先用工具写入能确认的字段，再追问剩余字段；不要等所有字段都收集完才写入。",
    "收集到足够信息（尤其是核心字段完整后），调用 send_setup_draft 发送格式化草稿，不要在回复正文中逐条列出设定。",
    "草稿发出后告知 owner 满意则输入 .confirm 完成初始化，如有修改继续告诉你即可。",
    "只写入 owner 明确提供的内容，不要编造设定；不要调用无关工具，不要修改用户资料或关系。",
    "绝对不要在回复正文中输出 .confirm；.confirm 只能由 owner 自己输入，模型不可代替输出。",
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
  recentToolEvents?: PromptInput["recentToolEvents"] | undefined;
  liveResources?: PromptInput["liveResources"] | undefined;
  toolsetRules?: PromptInput["toolsetRules"] | undefined;
  scenarioStateLines?: string[] | undefined;
  isInSetup?: boolean | undefined;
}): string[] {
  if (input.modeId === "assistant") {
    return [
      renderPromptSection("assistant_identity", buildAssistantIdentityLines()),
      renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
      renderPromptSection("reply_rules", buildReplyRuleLines()),
      renderPromptSection("context_rules", buildContextRuleLines({
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
        activeToolsets: input.activeToolsets,
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("live_resources", buildLiveResourceLines(input.liveResources)),
      renderPromptSection("history_summary", buildHistorySummaryLines(input.historySummary)),
      renderPromptSection("recent_tool_events", buildRecentToolEventLines(input.recentToolEvents))
    ].filter((item): item is string => Boolean(item));
  }

  if (input.modeId === "scenario_host") {
    if (input.isInSetup) {
      return [
        renderPromptSection("host_setup_mode", buildScenarioHostSetupModeLines()),
        renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
        renderPromptSection("context_rules", buildContextRuleLines({ visibleToolNames: input.visibleToolNames })),
        renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
          activeToolsets: input.activeToolsets,
          visibleToolNames: input.visibleToolNames
        })),
        renderPromptSection("participant_context", buildParticipantContextLines(input.sessionMode, input.participantProfiles))
      ].filter((item): item is string => Boolean(item));
    }
    return [
      renderPromptSection("host_identity", buildScenarioHostIdentityLines()),
      renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
      renderPromptSection("host_rules", buildScenarioHostRuleLines()),
      renderPromptSection("context_rules", buildContextRuleLines({
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
        activeToolsets: input.activeToolsets,
        visibleToolNames: input.visibleToolNames
      })),
      renderPromptSection("live_resources", buildLiveResourceLines(input.liveResources)),
      renderPromptSection("participant_context", buildParticipantContextLines(input.sessionMode, input.participantProfiles)),
      renderPromptSection("history_summary", buildHistorySummaryLines(input.historySummary)),
      renderPromptSection("recent_tool_events", buildRecentToolEventLines(input.recentToolEvents)),
      renderPromptSection("scenario_state", input.scenarioStateLines ?? []),
      renderPromptSection("current_user_profile", buildCurrentUserProfileLines({
        userProfile: input.userProfile,
        userMemories: []
      }))
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
    renderPromptSection("persona", buildIdentityLines(input.persona)),
    renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
    renderPromptSection("reply_rules", buildReplyRuleLines()),
    renderPromptSection("memory_write_decision", buildMemoryRuleLines()),
    renderPromptSection("context_rules", buildContextRuleLines({
      visibleToolNames: input.visibleToolNames
    })),
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
    renderPromptSection("recent_tool_events", buildRecentToolEventLines(input.recentToolEvents)),
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
    "你是普通中文 assistant，优先直接理解并完成用户请求。",
    "不要把自己当成角色扮演人物，也不要编造 persona、关系或背景设定。"
  ];
}

function buildScenarioHostIdentityLines(): string[] {
  return [
    "你是剧情主持模式下的场景主持者，负责描述环境、推进事件、控制非玩家角色，并回应玩家行动。",
    "默认用中文主持，不要把自己当成普通陪聊助手，也不要回到 RP 助手的人设口吻。"
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

function buildIdentityLines(persona: Persona): string[] {
  const personaSummary = [
    `名字=${persona.name}`,
    `角色=${persona.role}`,
    `性格=${persona.personality}`,
    `说话方式=${persona.speechStyle}`
  ].join("；");
  const extraFacts = [
    persona.appearance ? `外貌=${persona.appearance}` : null,
    persona.interests ? `兴趣与喜好=${persona.interests}` : null,
    persona.background ? `背景=${persona.background}` : null
  ].filter((item): item is string => Boolean(item));

  return [
    "你是具有角色扮演属性的聊天角色，默认以角色身份用中文自然聊天。",
    `角色设定：${personaSummary}`,
    ...(extraFacts.length > 0 ? [`补充设定：${extraFacts.join("；")}`] : []),
    ...(persona.rules ? [`角色规则：${persona.rules}`] : [])
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
    "1. bot 身份、人设、口吻、角色边界 -> persona。",
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
    persona.role,
    persona.personality,
    persona.speechStyle,
    persona.rules
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

function buildRecentToolEventLines(events: PromptToolEvent[] | undefined): string[] {
  if (!events || events.length === 0) {
    return [];
  }
  const lines = events
    .slice(-6)
    .map((event) => {
      const timestamp = event.timestampMs == null ? "时间未知" : formatCompactTimestamp(event.timestampMs);
      return `- ${timestamp} ${event.toolName}(${event.argsSummary || "无参数"}) -> ${event.outcome}：${event.resultSummary || "无摘要"}`;
    });
  return [`最近内部工具轨迹（仅供你延续当前任务，不要对用户直说）：\n${lines.join("\n")}`];
}

function buildToolsetRuleLines(rules: ToolsetRuleEntry[] | undefined): string[] {
  if (!rules || rules.length === 0) {
    return [];
  }
  return [`当前激活工具集相关长期规则（最多 ${MAX_VISIBLE_MEMORIES} 条）：\n${formatEntryLines(rules)}`];
}

function formatCompactTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestampMs));
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
  const activeToolsets = (input.activeToolsets ?? []).filter((item) => (item.promptGuidance?.length ?? 0) > 0);
  if (activeToolsets.length > 0) {
    lines.push(`当前激活工具集：${activeToolsets.map((item) => item.title).join("、")}`);
    for (const toolset of activeToolsets) {
      for (const guidance of toolset.promptGuidance ?? []) {
        lines.push(`- ${toolset.title}：${guidance}`);
      }
    }
  }
  if ((input.visibleToolNames ?? []).includes("request_toolset")) {
    lines.push("若当前激活工具集不够完成任务，可先查看可申请的工具集，再申请补充。");
  }
  return lines;
}

import { analyzeTurnPlannerBatch } from "#conversation/turnPlannerBatchAnalysis.ts";
import { buildTurnPlannerPrompt } from "#llm/prompts/turn-planner.prompt.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import {
  TOOLSET_DEFINITIONS,
  type ToolsetDefinition,
  type ToolsetView
} from "#llm/tools/toolsetCatalog.ts";

export type TurnPlannerProbeReplyDecision = "reply_small" | "reply_large" | "wait";
export type TurnPlannerProbeTopicDecision = "continue_topic" | "new_topic";
export type TurnPlannerProbeFollowupMode = "none" | "elliptical" | "explicit_reference";

export interface TurnPlannerProbeDecision {
  reason: string;
  replyDecision: TurnPlannerProbeReplyDecision;
  topicDecision: TurnPlannerProbeTopicDecision;
  requiredCapabilities: string[];
  contextDependencies: string[];
  recentDomainReuse: string[];
  followupMode: TurnPlannerProbeFollowupMode;
  toolsetIds: string[];
  normalizationWarnings: string[];
}

export interface TurnPlannerProbeExpectations {
  expectedReplyDecisions?: TurnPlannerProbeReplyDecision[];
  expectedTopicDecisions?: TurnPlannerProbeTopicDecision[];
  requiredToolsetIds?: string[];
  forbiddenToolsetIds?: string[];
}

export interface TurnPlannerProbeSemanticEvaluation {
  ok: boolean;
  issues: string[];
}

export type TurnPlannerProbeParseResult =
  | { ok: true; rawData: TurnPlannerProbeDecision; data: TurnPlannerProbeDecision }
  | { ok: false; error: string };

export interface TurnPlannerProbeBatchMessage {
  senderName: string;
  text: string;
  images: string[];
  audioSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: Array<{
    fileId: string;
    kind: string;
    semanticKind?: "image" | "emoji";
  }>;
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  mentionedSelf: boolean;
  timestampMs?: number | null;
}

export interface TurnPlannerProbeCase {
  id: string;
  title: string;
  sessionId?: string;
  chatType: "private" | "group";
  relationship: string;
  currentUserSpecialRole?: string | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>;
  batchMessages: TurnPlannerProbeBatchMessage[];
  expectations?: TurnPlannerProbeExpectations;
}

export interface TurnPlannerProbeCaseResult {
  caseId: string;
  rawText: string;
  parse: TurnPlannerProbeParseResult;
  semantic?: TurnPlannerProbeSemanticEvaluation;
}

export interface TurnPlannerProbeSummary {
  totalCases: number;
  okCases: number;
  failedCases: number;
  failedCaseIds: string[];
}

export interface TurnPlannerFormatProbeRunResult {
  modelRef: string[];
  summary: TurnPlannerProbeSummary;
  results: TurnPlannerProbeCaseResult[];
}

export interface TurnPlannerProbeExecutorInput {
  modelRef: string[];
  probeCase: TurnPlannerProbeCase;
  availableToolsets: ToolsetView[];
  promptMessages: LlmMessage[];
}

export interface TurnPlannerFormatProbeInput {
  modelRef: string[];
  availableToolsets: ToolsetView[];
  cases: TurnPlannerProbeCase[];
  executePrompt: (input: TurnPlannerProbeExecutorInput) => Promise<string>;
}

const REQUIRED_FIELDS = [
  "reason",
  "reply_decision",
  "topic_decision",
  "required_capabilities",
  "context_dependencies",
  "recent_domain_reuse",
  "followup_mode",
  "toolset_ids"
] as const;

const DEFAULT_PROBE_TOOLSET_IDS = [
  "chat_context",
  "conversation_navigation",
  "chat_delegation",
  "web_research",
  "shell_runtime",
  "local_file_io",
  "memory_profile",
  "scheduler_admin",
  "social_admin",
  "comfy_image",
  "time_utils"
] as const;

const PROBE_FORMAT_GUIDANCE = [
  "你正在参加 turn_planner 格式稳定性实验，必须严格输出下面 8 行，不得多写任何解释、前后缀、代码块或空行：",
  "reason: <少于20字的中文理由>",
  "reply_decision: <reply_small|reply_large|wait>",
  "topic_decision: <continue_topic|new_topic>",
  "required_capabilities: <逗号分隔标签；无则填 none>",
  "context_dependencies: <逗号分隔标签；无则填 none>",
  "recent_domain_reuse: <逗号分隔 toolset id；无则填 none>",
  "followup_mode: <none|elliptical|explicit_reference>",
  "toolset_ids: <逗号分隔 toolset id；无则填 none>",
  "required_capabilities 可用标签：external_info_lookup, web_navigation, local_file_access, chat_context_lookup, shell_execution, memory_write, scheduler_management, time_lookup, social_admin, conversation_navigation, chat_delegation, image_generation",
  "context_dependencies 可用标签：structured_message_context, prior_web_context, prior_shell_context, prior_file_context, prior_chat_context",
  "recent_domain_reuse 只可填写当前可用工具集中的 id。",
  "保持原 turn_planner 判定原则不变，只改变输出格式。缺失工具集比多给 1 个工具集代价更高。"
].join("\n");

const LEGACY_OUTPUT_FORMAT_RULE_LINES = [
  "输出格式严格单行：简短理由|<动作标签>|<话题标签>|<工具集ID列表>",
  "理由用中文，少于20字，给出直接依据。",
  "动作标签（三选一）：reply_small / reply_large / wait。",
  "话题标签（二选一）：continue_topic / new_topic（若动作为 wait，话题必须是 continue_topic）。",
  "工具集ID列表：",
  "- 动作为 wait 时填 -",
  "- reply_* 时填逗号分隔 ID，例如 web_research,memory_profile；若无需工具可填 none。",
  "只可从给定 available_toolsets 中挑选，不要编造 ID。",
  "若任务可能跨多个能力域，可一次返回多个工具集；但不要无谓扩大范围。"
] as const;

export function createProbeToolset(toolsetId: string): ToolsetView {
  const definition = TOOLSET_DEFINITIONS.find((item) => item.id === toolsetId);
  if (!definition) {
    return {
      id: toolsetId,
      title: toolsetId,
      description: `${toolsetId} probe toolset`,
      toolNames: [],
      plannerSignals: []
    };
  }
  return toProbeToolsetView(definition);
}

export function createDefaultTurnPlannerProbeToolsets(): ToolsetView[] {
  return DEFAULT_PROBE_TOOLSET_IDS.map((toolsetId) => createProbeToolset(toolsetId));
}

export function createDefaultTurnPlannerProbeCases(): TurnPlannerProbeCase[] {
  const now = Date.now();
  return [
    {
      id: "web-search",
      title: "外部信息查询",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "帮我查一下 OpenAI 最近的 API 定价变化。"
      }, now - 60_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        expectedTopicDecisions: ["new_topic"],
        requiredToolsetIds: ["web_research"]
      }
    },
    {
      id: "web-followup",
      title: "网页短跟进",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [
        {
          role: "assistant",
          content: "我先打开这个页面看看结构。",
          timestampMs: now - 50_000
        }
      ],
      batchMessages: [createProbeBatchMessage({
        text: "继续，点进去看看"
      }, now - 40_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        expectedTopicDecisions: ["continue_topic"],
        requiredToolsetIds: ["web_research"]
      }
    },
    {
      id: "web-download",
      title: "网页资源保存",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [
        {
          role: "assistant",
          content: "我已经打开目标页面了。",
          timestampMs: now - 30_000
        }
      ],
      batchMessages: [createProbeBatchMessage({
        text: "把这个页面里的图片下载到本地文件里。"
      }, now - 20_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["web_research", "local_file_io"]
      }
    },
    {
      id: "structured-context",
      title: "结构化上下文补全",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "你接着上面那个说。",
        replyMessageId: "msg-123"
      }, now - 10_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        expectedTopicDecisions: ["continue_topic"],
        requiredToolsetIds: ["chat_context"]
      }
    },
    {
      id: "structured-forward-context",
      title: "转发上下文补全",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "先看看转发里说了什么再回。",
        forwardIds: ["fwd-1"]
      }, now - 8_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["chat_context"]
      }
    },
    {
      id: "shell-debug",
      title: "shell 排障",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "看下 3000 端口是谁占着，再帮我看最近日志。"
      }, now - 5_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["shell_runtime", "local_file_io"]
      }
    },
    {
      id: "shell-followup",
      title: "shell 跟进",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [
        {
          role: "assistant",
          content: "我先跑一下进程列表。",
          timestampMs: now - 4_000
        }
      ],
      batchMessages: [createProbeBatchMessage({
        text: "继续看看日志最后 50 行"
      }, now - 3_500)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["shell_runtime"]
      }
    },
    {
      id: "conversation-navigation",
      title: "跨会话查历史",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "去另一个群里找下我昨天提过的那件事。"
      }, now - 3_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["conversation_navigation"]
      }
    },
    {
      id: "chat-delegation",
      title: "会话委派",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "把这条结论转告到项目群。"
      }, now - 2_500)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["chat_delegation"]
      }
    },
    {
      id: "memory-update",
      title: "长期偏好写入",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "记住我以后默认都要先给结论再解释。"
      }, now - 2_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["memory_profile"]
      }
    },
    {
      id: "user-self-info",
      title: "用户自述稳定资料",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "我现在住在上海，是产品经理，时区按北京时间算。"
      }, now - 1_900)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["memory_profile"]
      }
    },
    {
      id: "user-long-term-boundary",
      title: "长期偏好与边界",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "以后叫我老王，别替我做决定。"
      }, now - 1_800)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["memory_profile"]
      }
    },
    {
      id: "one-off-task-request",
      title: "一次性任务要求",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "这次把下面这段话润色成更正式的邮件。"
      }, now - 1_700)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        forbiddenToolsetIds: ["memory_profile"]
      }
    },
    {
      id: "scheduler-reminder",
      title: "提醒创建",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "明天上午十点提醒我提交周报。"
      }, now - 1_500)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["scheduler_admin"]
      }
    },
    {
      id: "time-question",
      title: "当前时间查询",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "现在几点了？"
      }, now - 1_000)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["time_utils"]
      }
    },
    {
      id: "social-admin",
      title: "白名单审批",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "把这个群放进白名单。"
      }, now - 800)],
      expectations: {
        expectedReplyDecisions: ["reply_small", "reply_large"],
        requiredToolsetIds: ["social_admin"]
      }
    },
    {
      id: "unfinished-wait",
      title: "半句话等待",
      chatType: "private",
      relationship: "owner",
      currentUserSpecialRole: null,
      recentMessages: [],
      batchMessages: [createProbeBatchMessage({
        text: "比如我觉得这个问题主要是"
      }, now)],
      expectations: {
        expectedReplyDecisions: ["wait"],
        expectedTopicDecisions: ["continue_topic"]
      }
    }
  ];
}

export function parseTurnPlannerProbeResponse(rawText: string): TurnPlannerProbeParseResult {
  const normalized = rawText.trim();
  if (!normalized) {
    return { ok: false, error: "empty response" };
  }

  const fieldMap = new Map<string, string>();
  for (const line of normalized.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!match) {
      return { ok: false, error: `invalid line: ${trimmed}` };
    }
    fieldMap.set(match[1] ?? "", (match[2] ?? "").trim());
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fieldMap.has(field)) {
      return { ok: false, error: `missing ${field}` };
    }
  }

  const reason = fieldMap.get("reason") ?? "";
  const replyDecision = fieldMap.get("reply_decision") ?? "";
  const topicDecision = fieldMap.get("topic_decision") ?? "";
  const followupMode = fieldMap.get("followup_mode") ?? "";

  if (!isReplyDecision(replyDecision)) {
    return { ok: false, error: `invalid reply_decision: ${replyDecision}` };
  }
  if (!isTopicDecision(topicDecision)) {
    return { ok: false, error: `invalid topic_decision: ${topicDecision}` };
  }
  if (!isFollowupMode(followupMode)) {
    return { ok: false, error: `invalid followup_mode: ${followupMode}` };
  }
  if (!reason) {
    return { ok: false, error: "missing reason" };
  }

  return {
    ok: true,
    rawData: {
      reason,
      replyDecision,
      topicDecision,
      requiredCapabilities: parseListField(fieldMap.get("required_capabilities") ?? ""),
      contextDependencies: parseListField(fieldMap.get("context_dependencies") ?? ""),
      recentDomainReuse: parseListField(fieldMap.get("recent_domain_reuse") ?? ""),
      followupMode,
      toolsetIds: parseListField(fieldMap.get("toolset_ids") ?? ""),
      normalizationWarnings: []
    },
    data: normalizeTurnPlannerProbeDecision({
      reason,
      replyDecision,
      topicDecision,
      requiredCapabilities: parseListField(fieldMap.get("required_capabilities") ?? ""),
      contextDependencies: parseListField(fieldMap.get("context_dependencies") ?? ""),
      recentDomainReuse: parseListField(fieldMap.get("recent_domain_reuse") ?? ""),
      followupMode,
      toolsetIds: parseListField(fieldMap.get("toolset_ids") ?? ""),
      normalizationWarnings: []
    })
  };
}

export async function runTurnPlannerFormatProbe(input: TurnPlannerFormatProbeInput): Promise<TurnPlannerFormatProbeRunResult> {
  const results: TurnPlannerProbeCaseResult[] = [];
  for (const probeCase of input.cases) {
    const promptMessages = buildTurnPlannerFormatProbePrompt(probeCase, input.availableToolsets);
    const rawText = await input.executePrompt({
      modelRef: input.modelRef,
      probeCase,
      availableToolsets: input.availableToolsets,
      promptMessages
    });
    const parsed = parseTurnPlannerProbeResponse(rawText);
    const parse = parsed.ok
      ? {
          ...parsed,
          data: normalizeTurnPlannerProbeDecisionForCase(probeCase, parsed.data)
        }
      : parsed;
    results.push({
      caseId: probeCase.id,
      rawText,
      parse,
      ...(parse.ok ? { semantic: evaluateTurnPlannerProbeSemantics(probeCase, parse.data) } : {})
    });
  }

  return {
    modelRef: input.modelRef,
    results,
    summary: summarizeTurnPlannerProbeResults(results)
  };
}

export function summarizeTurnPlannerProbeResults(results: TurnPlannerProbeCaseResult[]): TurnPlannerProbeSummary {
  const failedCaseIds = results.filter((item) => !item.parse.ok).map((item) => item.caseId);
  return {
    totalCases: results.length,
    okCases: results.length - failedCaseIds.length,
    failedCases: failedCaseIds.length,
    failedCaseIds
  };
}

export function renderTurnPlannerProbeReport(result: TurnPlannerFormatProbeRunResult): string {
  const lines = [
    `turn-planner-format-probe model=${result.modelRef.join(",")} total=${result.summary.totalCases} ok=${result.summary.okCases} failed=${result.summary.failedCases}`
  ];

  for (const item of result.results) {
    if (item.parse.ok) {
      lines.push(`- ${item.caseId}: ok reply=${item.parse.data.replyDecision} topic=${item.parse.data.topicDecision} toolsets=${item.parse.data.toolsetIds.join(",") || "none"} semantic=${item.semantic?.ok === false ? "mismatch" : "ok"}`);
      if (item.parse.rawData.replyDecision !== item.parse.data.replyDecision) {
        lines.push(`  raw_reply=${item.parse.rawData.replyDecision}`);
      }
      if (item.parse.rawData.topicDecision !== item.parse.data.topicDecision) {
        lines.push(`  raw_topic=${item.parse.rawData.topicDecision}`);
      }
      if (item.parse.rawData.toolsetIds.join(",") !== item.parse.data.toolsetIds.join(",")) {
        lines.push(`  raw_toolsets=${item.parse.rawData.toolsetIds.join(",") || "none"}`);
      }
      for (const warning of item.parse.data.normalizationWarnings) {
        lines.push(`  warning=${warning}`);
      }
      for (const issue of item.semantic?.issues ?? []) {
        lines.push(`  semantic_issue=${issue}`);
      }
      continue;
    }
    lines.push(`- ${item.caseId}: fail error=${item.parse.error}`);
    lines.push(`  raw=${singleLine(item.rawText)}`);
  }

  if (result.summary.failedCaseIds.length > 0) {
    lines.push(`failed_cases=${result.summary.failedCaseIds.join(",")}`);
  }

  return lines.join("\n");
}

export function evaluateTurnPlannerProbeSemantics(
  probeCase: TurnPlannerProbeCase,
  decision: TurnPlannerProbeDecision
): TurnPlannerProbeSemanticEvaluation {
  const issues: string[] = [];
  const expected = probeCase.expectations;
  if (!expected) {
    return { ok: true, issues };
  }
  if (expected.expectedReplyDecisions && !expected.expectedReplyDecisions.includes(decision.replyDecision)) {
    issues.push(`unexpected_reply:${decision.replyDecision}`);
  }
  if (expected.expectedTopicDecisions && !expected.expectedTopicDecisions.includes(decision.topicDecision)) {
    issues.push(`unexpected_topic:${decision.topicDecision}`);
  }
  const selected = new Set(decision.toolsetIds);
  for (const toolsetId of expected.requiredToolsetIds ?? []) {
    if (!selected.has(toolsetId)) {
      issues.push(`missing_required_toolset:${toolsetId}`);
    }
  }
  for (const toolsetId of expected.forbiddenToolsetIds ?? []) {
    if (selected.has(toolsetId)) {
      issues.push(`forbidden_toolset:${toolsetId}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function createTurnPlannerFormatProbeExecutor(input: {
  client: Pick<LlmClient, "generate">;
  timeoutMs?: number;
}) {
  return async ({ modelRef, promptMessages }: TurnPlannerProbeExecutorInput): Promise<string> => {
    const result = await input.client.generate({
      modelRefOverride: modelRef,
      enableThinkingOverride: false,
      preferNativeNoThinkingChatEndpoint: true,
      skipDebugDump: true,
      messages: promptMessages,
      ...(typeof input.timeoutMs === "number" ? { timeoutMsOverride: input.timeoutMs } : {})
    });
    return result.text;
  };
}

export function buildTurnPlannerFormatProbePrompt(
  probeCase: TurnPlannerProbeCase,
  availableToolsets: ToolsetView[]
): LlmMessage[] {
  const basePrompt = buildTurnPlannerPrompt({
    sessionId: probeCase.sessionId ?? `probe-${probeCase.id}`,
    chatType: probeCase.chatType,
    relationship: probeCase.relationship,
    currentUserSpecialRole: probeCase.currentUserSpecialRole ?? null,
    recentMessages: probeCase.recentMessages,
    batchMessages: probeCase.batchMessages,
    availableToolsets,
    batchAnalysis: analyzeTurnPlannerBatch(probeCase.batchMessages),
    emojiInputs: []
  });

  return basePrompt.map((message, index) => {
    if (index !== 0 || message.role !== "system" || typeof message.content !== "string") {
      return message;
    }
    return {
      ...message,
      content: `${stripLegacyOutputFormatRules(message.content)}\n\n${PROBE_FORMAT_GUIDANCE}`
    };
  });
}

function createProbeBatchMessage(
  overrides: Partial<TurnPlannerProbeBatchMessage>,
  timestampMs: number
): TurnPlannerProbeBatchMessage {
  return {
    senderName: "Tester",
    text: "",
    images: [],
    audioSources: [],
    imageIds: [],
    emojiIds: [],
    attachments: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs,
    ...overrides
  };
}

function toProbeToolsetView(definition: ToolsetDefinition): ToolsetView {
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    toolNames: [...definition.toolNames],
    ...(definition.promptGuidance && definition.promptGuidance.length > 0
      ? { promptGuidance: [...definition.promptGuidance] }
      : {}),
    ...(definition.plannerSignals && definition.plannerSignals.length > 0
      ? { plannerSignals: [...definition.plannerSignals] }
      : {})
  };
}

function parseListField(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "-") {
    return [];
  }
  return normalized.split(/[\s,，|]+/g).map((item) => item.trim()).filter(Boolean);
}

function isReplyDecision(value: string): value is TurnPlannerProbeReplyDecision {
  return value === "reply_small" || value === "reply_large" || value === "wait";
}

function isTopicDecision(value: string): value is TurnPlannerProbeTopicDecision {
  return value === "continue_topic" || value === "new_topic";
}

function isFollowupMode(value: string): value is TurnPlannerProbeFollowupMode {
  return value === "none" || value === "elliptical" || value === "explicit_reference";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripLegacyOutputFormatRules(content: string): string {
  return content
    .split("\n")
    .filter((line) => !LEGACY_OUTPUT_FORMAT_RULE_LINES.includes(line.trim() as typeof LEGACY_OUTPUT_FORMAT_RULE_LINES[number]))
    .join("\n");
}

function normalizeTurnPlannerProbeDecision(input: TurnPlannerProbeDecision): TurnPlannerProbeDecision {
  const normalizationWarnings = [...input.normalizationWarnings];
  const toolsetIds = [...input.toolsetIds];
  let topicDecision = input.topicDecision;

  if (input.replyDecision === "wait" && topicDecision !== "continue_topic") {
    topicDecision = "continue_topic";
    normalizationWarnings.push("wait_forces_continue_topic");
  }
  if (input.requiredCapabilities.includes("local_file_access") && !toolsetIds.includes("local_file_io")) {
    toolsetIds.push("local_file_io");
    normalizationWarnings.push("capability_requires_local_file_io");
  }
  if (input.requiredCapabilities.includes("shell_execution") && !toolsetIds.includes("shell_runtime")) {
    toolsetIds.push("shell_runtime");
    normalizationWarnings.push("capability_requires_shell_runtime");
  }
  if (input.requiredCapabilities.includes("memory_write") && !toolsetIds.includes("memory_profile")) {
    toolsetIds.push("memory_profile");
    normalizationWarnings.push("capability_requires_memory_profile");
  }
  if (
    (input.requiredCapabilities.includes("web_navigation") || input.requiredCapabilities.includes("external_info_lookup"))
    && !toolsetIds.includes("web_research")
  ) {
    toolsetIds.push("web_research");
    normalizationWarnings.push("capability_requires_web_research");
  }
  if (input.requiredCapabilities.includes("conversation_navigation") && !toolsetIds.includes("conversation_navigation")) {
    toolsetIds.push("conversation_navigation");
    normalizationWarnings.push("capability_requires_conversation_navigation");
  }
  if (input.requiredCapabilities.includes("chat_delegation") && !toolsetIds.includes("chat_delegation")) {
    toolsetIds.push("chat_delegation");
    normalizationWarnings.push("capability_requires_chat_delegation");
  }
  return {
    ...input,
    topicDecision,
    toolsetIds,
    normalizationWarnings
  };
}

function normalizeTurnPlannerProbeDecisionForCase(
  probeCase: TurnPlannerProbeCase,
  input: TurnPlannerProbeDecision
): TurnPlannerProbeDecision {
  if (!probeCaseHasStructuredResolvableContent(probeCase) || input.toolsetIds.includes("chat_context")) {
    return input;
  }
  if (!input.contextDependencies.includes("structured_message_context")) {
    return input;
  }
  return {
    ...input,
    toolsetIds: [...input.toolsetIds, "chat_context"],
    normalizationWarnings: [...input.normalizationWarnings, "structured_context_requires_chat_context"]
  };
}

function probeCaseHasStructuredResolvableContent(probeCase: TurnPlannerProbeCase): boolean {
  return probeCase.batchMessages.some((message) => (
    Boolean(message.replyMessageId)
    || (message.forwardIds?.length ?? 0) > 0
    || (message.imageIds?.length ?? 0) > 0
    || (message.emojiIds?.length ?? 0) > 0
    || (message.attachments?.length ?? 0) > 0
  ));
}

import pino from "pino";
import type { AppConfig } from "#config/config.ts";
import { buildTurnPlannerChatRequest, parseStructuredPlannerResult } from "#conversation/turnPlanner/chat.ts";
import { normalizeTurnPlan } from "#conversation/turnPlanner/result.ts";
import type { PreparedTurnPlannerInput, TurnPlannerInput, TurnPlannerResult } from "#conversation/turnPlanner/types.ts";
import { resolveAutoActivatedToolsets } from "./toolsetAutoActivation.ts";
import { supplementPlannedToolsets } from "./toolsetSupplement.ts";
import { analyzeTurnPlannerBatch } from "#conversation/turnPlannerBatchAnalysis.ts";
import { buildTurnPlannerPrompt } from "#llm/prompts/turn-planner.prompt.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import {
  TOOLSET_DEFINITIONS,
  type ToolsetDefinition,
  type ToolsetView
} from "#llm/tools/toolsetCatalog.ts";

export type TurnPlannerProbeReplyDecision = TurnPlannerResult["replyDecision"];
export type TurnPlannerProbeTopicDecision = "continue_topic" | "new_topic";
export type TurnPlannerProbeFollowupMode = "none" | "elliptical" | "explicit_reference";

export interface TurnPlannerProbeDecision {
  reason: string;
  taskBasis?: string;
  modelTier?: "small" | "large";
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
  expectedModelTiers?: Array<"small" | "large">;
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
  attachments?: NonNullable<TurnPlannerInput["batchMessages"][number]["attachments"]>;
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
  relationship: TurnPlannerInput["relationship"];
  currentUserSpecialRole?: TurnPlannerInput["currentUserSpecialRole"];
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
  config: AppConfig;
  modelRef: string[];
  availableToolsets: ToolsetView[];
  cases: TurnPlannerProbeCase[];
  executePrompt: (input: TurnPlannerProbeExecutorInput) => Promise<string>;
}

const DEFAULT_PROBE_TOOLSET_IDS = [
  "chat_context",
  "conversation_navigation",
  "chat_delegation",
  "web_research",
  "shell_runtime",
  "filesystem_io",
  "memory_profile",
  "scheduler_admin",
  "social_admin",
  "image_generation",
  "comfy_image",
  "time_utils"
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        text: "继续打开之前搜索结果中的文章，阅读并总结内容。"
      }, now - 40_000)],
      expectations: {
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        text: "把这个页面里的图片保存到宿主机 /srv/reports/current.png，覆盖已有文件。"
      }, now - 20_000)],
      expectations: {
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["large"],
        requiredToolsetIds: ["web_research", "filesystem_io"]
      }
    },
    {
      id: "web-asset-download", title: "网页资源作为当前附件", chatType: "private", relationship: "owner",
      currentUserSpecialRole: null, recentMessages: [],
      batchMessages: [createProbeBatchMessage({ text: "将这张公开网页图片下载为登记附件，发到当前会话，不指定宿主机路径。" }, now - 18_000)],
      expectations: { expectedReplyDecisions: ["reply"], expectedModelTiers: ["small"], requiredToolsetIds: ["web_research"] }
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["large"],
        requiredToolsetIds: ["shell_runtime", "filesystem_io"]
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
        text: "继续运行命令，读取宿主机日志文件最后 50 行。"
      }, now - 3_500)],
      expectations: {
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["large"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["large"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["small"],
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
        expectedReplyDecisions: ["reply"],
        expectedModelTiers: ["large"],
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
        text: "比如说"
      }, now)],
      expectations: {
        expectedReplyDecisions: ["wait"],
        expectedTopicDecisions: ["continue_topic"]
      }
    }
  ];
}

export function parseTurnPlannerProbeResponse(
  rawText: string,
  probeCase: TurnPlannerProbeCase,
  availableToolsets: ToolsetView[],
  config: AppConfig
): TurnPlannerProbeParseResult {
  const prepared = buildTurnPlannerProbeInput(probeCase, availableToolsets);
  const plan = parseStructuredPlannerResult(rawText.trim(), prepared);
  if (!plan) return { ok: false, error: "invalid planner protocol" };
  const rawData: TurnPlannerProbeDecision = { ...plan, normalizationWarnings: [] };
  const normalized = normalizeTurnPlan(plan, prepared, prepared.batchAnalysis, config, pino({ level: "silent" }));
  const warnings: string[] = [];
  if (normalized.replyDecision !== rawData.replyDecision) warnings.push("reply_decision_normalized");
  if (normalized.topicDecision !== rawData.topicDecision) warnings.push("topic_decision_normalized");
  let toolsetIds = normalized.toolsetIds;
  if (normalized.replyDecision === "reply") {
    const activation = resolveAutoActivatedToolsets({
      availableToolsets, selectedToolsetIds: toolsetIds, modeId: "default",
      recentMessages: probeCase.recentMessages, plannerDecision: normalized,
      batchMessages: probeCase.batchMessages.map(message => ({
        ...message, userId: "probe", chatType: probeCase.chatType,
        audioIds: [], emojiSources: [], isAtMentioned: message.mentionedSelf,
        receivedAt: message.timestampMs ?? 0
      }))
    });
    const supplement = supplementPlannedToolsets({
      availableToolsets, selectedToolsetIds: activation.toolsetIds,
      recentTranscriptItems: [], plannerDecision: normalized
    });
    toolsetIds = supplement.toolsetIds;
    warnings.push(...activation.reasons, ...supplement.reasons);
  }
  return { ok: true, rawData, data: { ...normalized, toolsetIds, normalizationWarnings: warnings } };
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
    const parse = parseTurnPlannerProbeResponse(rawText, probeCase, input.availableToolsets, input.config);
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
  const failedCaseIds = results.filter((item) => !item.parse.ok || item.semantic?.ok === false).map((item) => item.caseId);
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
      lines.push(`- ${item.caseId}: ok reply=${item.parse.data.replyDecision} model=${item.parse.data.modelTier ?? "undetermined"} topic=${item.parse.data.topicDecision} toolsets=${item.parse.data.toolsetIds.join(",") || "none"} semantic=${item.semantic?.ok === false ? "mismatch" : "ok"}`);
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
  if (expected.expectedModelTiers && (!decision.modelTier || !expected.expectedModelTiers.includes(decision.modelTier))) {
    issues.push(`unexpected_model:${decision.modelTier ?? "undetermined"}`);
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
  config: AppConfig;
  client: Pick<LlmClient, "generate"> & Partial<Pick<LlmClient, "supportsStructuredOutput">>;
  timeoutMs?: number;
}) {
  return async ({ modelRef, probeCase, availableToolsets }: TurnPlannerProbeExecutorInput): Promise<string> => {
    const prepared = buildTurnPlannerProbeInput(probeCase, availableToolsets);
    const result = await input.client.generate(buildTurnPlannerChatRequest(
      input.config, input.client, prepared, modelRef,
      input.timeoutMs ?? input.config.llm.turnPlanner.timeoutMs
    ));
    return result.text;
  };
}

export function buildTurnPlannerFormatProbePrompt(
  probeCase: TurnPlannerProbeCase,
  availableToolsets: ToolsetView[]
): LlmMessage[] {
  return buildTurnPlannerPrompt(buildTurnPlannerProbeInput(probeCase, availableToolsets));
}

export function buildTurnPlannerProbeInput(probeCase: TurnPlannerProbeCase, availableToolsets: ToolsetView[]): PreparedTurnPlannerInput {
  return {
    requirements: { modelSelection: true, toolSelection: true, replyGate: probeCase.chatType === "group", semanticWait: true, topicSwitch: true, taskIntent: false },
    sessionId: probeCase.sessionId ?? `probe-${probeCase.id}`,
    chatType: probeCase.chatType,
    relationship: probeCase.relationship,
    currentUserSpecialRole: probeCase.currentUserSpecialRole ?? null,
    recentMessages: probeCase.recentMessages,
    batchMessages: probeCase.batchMessages,
    availableToolsets,
    batchAnalysis: analyzeTurnPlannerBatch(probeCase.batchMessages),
    visualInputs: [],
    mediaCaptions: []
  };
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
    ...(definition.plannerSignals && definition.plannerSignals.length > 0
      ? { plannerSignals: [...definition.plannerSignals] }
      : {})
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

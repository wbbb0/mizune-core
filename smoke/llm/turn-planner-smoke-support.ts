import { parseArgs } from "node:util";
import { buildPlannerQuestions, applyPlannerAnswers, type PlannerAnswer } from "../../src/conversation/turnPlanner/definitions.ts";
import { parseStructuredPlannerResult } from "../../src/conversation/turnPlanner/chat.ts";
import { analyzeTurnPlannerBatch } from "../../src/conversation/turnPlannerBatchAnalysis.ts";
import type { PreparedTurnPlannerInput, TurnPlannerResult } from "../../src/conversation/turnPlanner/types.ts";
import type { LlmMessage, LlmResponseFormat, LlmUsage } from "../../src/llm/provider/providerTypes.ts";
import { buildTurnPlannerPrompt, buildTurnPlannerResponseFormat } from "../../src/llm/prompts/turn-planner.prompt.ts";
import { renderPromptSection } from "../../src/llm/prompts/prompt-section.ts";
import { buildOpenTag } from "../../src/utils/structuredEnvelope.ts";

export const plannerSmokeModes = ["task_basis", "direct", "short_basis"] as const;
export type PlannerSmokeMode = typeof plannerSmokeModes[number];
export type PlannerSmokeBackend = "chat" | "decision";
export interface PlannerSmokeCase { id: string; text: string; expectedTier: "small" | "large" }
export const plannerSmokeCases: readonly PlannerSmokeCase[] = [
  { id: "public-query", text: "搜索公开网页，简要介绍日食形成的原因并给出来源。只查询资料，不提交或修改网页。", expectedTier: "small" },
  { id: "host-shell", text: "请在宿主机执行命令查看示例服务的运行状态，再读取其启动日志定位故障。", expectedTier: "large" },
  { id: "host-file", text: "读取宿主机 /srv/smoke-example/service.conf，指出示例服务配置的监听端口。", expectedTier: "large" },
  { id: "bounded-attachment", text: "把已经登记的 CSV 附件在系统限定的临时工作区内整理成按日期排序的新文件，不执行代码，不访问宿主机通用路径。", expectedTier: "small" },
  { id: "permission-policy", text: "修改聊天白名单权限，并发布一条以后所有任务都生效的全局执行规则。", expectedTier: "large" },
  { id: "complex-quality", text: "设计一个涉及多个共享资源的并发状态机，权衡相互冲突的约束，形式化说明取消与重试的一致性，并推导不变量。", expectedTier: "large" },
  { id: "current-reply", text: "把我提供的一句普通通知润色得自然一点，直接回复当前聊天即可：明天下午三点开例会。", expectedTier: "small" },
  { id: "profile-preference", text: "请在我的用户资料里记住我喜欢简短回复，只更新我的这条普通偏好，不修改任何全局或工具执行规则。", expectedTier: "small" }
];

export interface PlannerSmokeOptions {
  configDir?: string;
  instance?: string;
  modelRef?: string;
  backend: PlannerSmokeBackend;
  modes: readonly PlannerSmokeMode[];
  timeoutMs: number;
  repeat: number;
  selectedCases: readonly PlannerSmokeCase[];
  help: boolean;
  list: boolean;
}

export function parsePlannerSmokeOptions(argv: string[]): PlannerSmokeOptions {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    "config-dir": { type: "string" }, instance: { type: "string" }, "model-ref": { type: "string" },
    backend: { type: "string", default: "chat" }, mode: { type: "string" }, compare: { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "30000" }, repeat: { type: "string", default: "1" },
    case: { type: "string" }, help: { type: "boolean", default: false }, list: { type: "boolean", default: false }
  } });
  if (values.backend !== "chat" && values.backend !== "decision") throw new Error("backend 只能为 chat 或 decision");
  if (values.mode && !plannerSmokeModes.includes(values.mode as PlannerSmokeMode)) throw new Error("mode 不在允许范围");
  if (values.compare && values.mode) throw new Error("compare 与 mode 不能同时指定");
  if (values.backend === "decision" && (values.compare || (values.mode && values.mode !== "task_basis"))) throw new Error("Decision 不支持聊天依据对照模式");
  const timeoutMs = Number(values["timeout-ms"]);
  const repeat = Number(values.repeat);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw new Error("timeout-ms 须为 100 至 600000 的整数");
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("repeat 须为 1 至 20 的整数");
  const ids = values.case?.split(",").map(value => value.trim()).filter(Boolean);
  if (ids && (!ids.length || ids.some(id => !plannerSmokeCases.some(item => item.id === id)))) throw new Error("case 不在合成用例范围");
  for (const value of [values["config-dir"], values.instance, values["model-ref"]]) if (value !== undefined && !value.trim()) throw new Error("配置选择参数不得为空");
  return {
    ...(values["config-dir"] ? { configDir: values["config-dir"] } : {}),
    ...(values.instance ? { instance: values.instance } : {}),
    ...(values["model-ref"] ? { modelRef: values["model-ref"] } : {}),
    backend: values.backend, modes: values.compare ? plannerSmokeModes : [values.mode as PlannerSmokeMode ?? "task_basis"],
    timeoutMs, repeat, selectedCases: ids ? plannerSmokeCases.filter(item => ids.includes(item.id)) : plannerSmokeCases,
    help: values.help, list: values.list
  };
}

export function buildPlannerSmokeInput(item: PlannerSmokeCase): PreparedTurnPlannerInput {
  const batchMessages = [{ senderName: "合成测试用户", text: item.text, images: [], audioSources: [], imageIds: [], emojiIds: [],
    forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, mentionedSelf: false }];
  return {
    requirements: { modelSelection: true, toolSelection: false, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: false },
    sessionId: "smoke:planner:synthetic", chatType: "private", relationship: "owner", recentMessages: [], batchMessages,
    availableToolsets: [], batchAnalysis: analyzeTurnPlannerBatch(batchMessages), visualInputs: [], mediaCaptions: []
  };
}

/** Comparison-only rendering: production semantic definitions are unchanged. */
export function buildPlannerSmokeChatRequest(input: PreparedTurnPlannerInput, mode: PlannerSmokeMode): { messages: LlmMessage[]; responseFormat: LlmResponseFormat } {
  const messages = buildTurnPlannerPrompt(input);
  const responseFormat = structuredClone(buildTurnPlannerResponseFormat(input));
  if (mode === "task_basis") return { messages, responseFormat };
  if (responseFormat.type !== "json_schema") throw new Error("评测需要生成的 JSON Schema");
  const schema = responseFormat.schema as { properties: Record<string, { maxLength?: number }>; required: string[] };
  if (mode === "direct") {
    delete schema.properties.task_basis;
    schema.required = schema.required.filter(key => key !== "task_basis");
  } else {
    schema.properties.task_basis!.maxLength = 12;
  }
  const system = messages[0];
  if (!system || typeof system.content !== "string") throw new Error("评测提示格式无效");
  const outputStart = system.content.lastIndexOf(buildOpenTag("section", { name: "planner_output" }));
  if (outputStart < 0) throw new Error("缺少生成的输出约束");
  const fields = buildPlannerQuestions(input).map(definition => definition.question.name);
  const output = renderPromptSection("planner_output", [
    "严格输出一个 JSON object，不得添加解释、空行或代码块。",
    mode === "direct"
      ? "直接输出判断，不输出 task_basis、理由或推理过程。"
      : "必须首先生成 task_basis：用不超过 12 字的中文概括可见任务依据，不提前写判断结论，不编造事实。",
    "然后按下列顺序输出字段；单选填选项值，条件判断填 true 或 false，无法判定填 null；不得遗漏或添加字段。",
    ...fields
  ]);
  system.content = `${system.content.slice(0, outputStart)}${output}`;
  return { messages, responseFormat };
}

/** Control modes are intentionally confined to this opt-in evaluator. */
export function parsePlannerSmokeChatOutput(raw: string, input: PreparedTurnPlannerInput, mode: PlannerSmokeMode): TurnPlannerResult | null {
  if (mode === "task_basis") return parseStructuredPlannerResult(raw.trim(), input);
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const values = decoded as Record<string, unknown>;
  const definitions = buildPlannerQuestions(input);
  const expected = [...(mode === "short_basis" ? ["task_basis"] : []), ...definitions.map(({ question }) => question.name)];
  const keys = flatScalarObjectKeys(raw.trim());
  if (!keys || keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (mode === "short_basis" && (typeof values.task_basis !== "string" || !values.task_basis.trim() || [...values.task_basis].length > 12)) return null;
  const answers = new Map<string, PlannerAnswer>();
  for (const { question } of definitions) {
    const value = values[question.name];
    if (value !== null && (question.type === "predicate" ? typeof value !== "boolean" : !question.choices.some(choice => choice.value === value))) return null;
    answers.set(question.name, { value: value as string | boolean | null });
  }
  return applyPlannerAnswers(input, definitions, answers);
}

/** Comparison protocols are flat scalar objects; preserve duplicate keys discarded by JSON.parse. */
function flatScalarObjectKeys(raw: string): string[] | null {
  const keys: string[] = [];
  const entry = /\s*("(?:[^"\\]|\\.)*")\s*:\s*(?:null|true|false|"(?:[^"\\]|\\.)*")\s*/gy;
  let offset = 1;
  while (offset < raw.length - 1) {
    entry.lastIndex = offset;
    const match = entry.exec(raw);
    if (!match) return null;
    keys.push(JSON.parse(match[1]!));
    offset = entry.lastIndex;
    if (offset === raw.length - 1) return keys;
    if (raw[offset] !== ",") return null;
    offset++;
  }
  return keys;
}

export interface PlannerSmokeResult {
  backend: PlannerSmokeBackend;
  mode: PlannerSmokeMode;
  caseId: string;
  iteration: number;
  modelRef: string;
  expectedTier: "small" | "large";
  actualTier: "small" | "large" | null;
  parseOk: boolean;
  determined: boolean;
  passed: boolean;
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  errorCode?: "request_failed" | "invalid_output";
}

export function scorePlannerSmokeResult(input: {
  backend: PlannerSmokeBackend; mode: PlannerSmokeMode; item: PlannerSmokeCase; iteration: number; modelRef: string;
  plan: TurnPlannerResult | null; elapsedMs: number; usage?: LlmUsage; requestFailed?: boolean
}): PlannerSmokeResult {
  const determined = input.plan?.modelSelectionStatus === "decided" && input.plan.modelTier !== undefined
    && !input.plan.undeterminedQuestions?.length;
  const actualTier = determined ? input.plan!.modelTier! : null;
  return {
    backend: input.backend, mode: input.mode, caseId: input.item.id, iteration: input.iteration,
    modelRef: input.usage?.modelRef ?? input.modelRef, expectedTier: input.item.expectedTier, actualTier,
    parseOk: input.plan !== null, determined, passed: determined && actualTier === input.item.expectedTier,
    elapsedMs: input.elapsedMs, inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null, cachedTokens: input.usage?.cachedTokens ?? null,
    ...(input.requestFailed ? { errorCode: "request_failed" as const } : !input.plan ? { errorCode: "invalid_output" as const } : {})
  };
}

export function summarizePlannerSmokeResults(results: readonly PlannerSmokeResult[]) {
  const times = results.map(item => item.elapsedMs).sort((left, right) => left - right);
  const total = results.length;
  const count = (test: (item: PlannerSmokeResult) => boolean) => results.filter(test).length;
  const sum = (key: "inputTokens" | "outputTokens" | "cachedTokens") => !total || results.some(item => item[key] === null)
    ? null : results.reduce((value, item) => value + item[key]!, 0);
  const correct = count(item => item.passed);
  return {
    total, parsed: count(item => item.parseOk), determined: count(item => item.determined), correct,
    accuracy: total ? correct / total : null,
    missedUpgrades: count(item => item.expectedTier === "large" && item.actualTier === "small"),
    extraUpgrades: count(item => item.expectedTier === "small" && item.actualTier === "large"),
    undetermined: count(item => item.parseOk && !item.determined), requestFailures: count(item => item.errorCode === "request_failed"),
    elapsedMs: times.reduce((value, time) => value + time, 0), p95Ms: total ? times[Math.ceil(total * 0.95) - 1]! : null,
    inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cachedTokens: sum("cachedTokens")
  };
}

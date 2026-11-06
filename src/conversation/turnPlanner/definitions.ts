import { modelSelectionScoresSchema } from "./modelSelectionScores.ts";
import type { DecisionQuestion } from "#llm/provider/nativeCapabilityTypes.ts";
import { MODEL_SELECTION_INSTRUCTIONS, MODEL_SELECTION_LARGE_WHEN, MODEL_SELECTION_SMALL_WHEN, STATEFUL_RP_MODEL_SELECTION_RULE } from "#llm/shared/modelSelectionPolicy.ts";
import { taskPlannerIntentKinds, type TaskPlannerIntentKind } from "../taskTracker/taskTrackerPlannerContext.ts";
import { getTurnPlannerReplyOptions } from "../turnPlannerPolicy.ts";
import { createDefaultTurnPlan } from "./result.ts";
import { turnPlannerContextDependencies, turnPlannerRequiredCapabilities, type TurnPlannerInput, type TurnPlannerResult } from "./types.ts";

import { PLANNER_ACTION_CONFIDENCE, PLANNER_SKILL_LIMIT, PLANNER_MAX_QUESTIONS, PLANNER_MAX_CHOICES } from "./limits.ts";
export { PLANNER_TASK_BASIS_MAX_LENGTH, PLANNER_ACTION_CONFIDENCE, PLANNER_SKILL_LIMIT, PLANNER_MAX_QUESTIONS, PLANNER_MAX_CHOICES } from "./limits.ts";
export type PlannerDefinitionInput = Pick<TurnPlannerInput, "requirements" | "availableSkills" | "availableToolsets" | "taskContext" | "modeId">;
export interface PlannerAnswer {
  value: string | boolean | null;
  probability?: number;
  confidence?: number;
  probabilities?: Array<{ value: string | boolean; probability: number }>;
}
export interface PlannerQuestionDefinition {
  question: Extract<DecisionQuestion, { type: "choice" | "predicate" }>;
  threshold?: number;
  choicePolicy?: "highest_probability";
  apply: (answer: PlannerAnswer, plan: TurnPlannerResult) => void;
}
const capabilityDescriptions: Record<typeof turnPlannerRequiredCapabilities[number], string> = {
  external_info_lookup: "需要查询或核实外部信息；仅解释已有材料不算",
  web_navigation: "需要打开、阅读或操作网页；仅讨论网页技术不算",
  filesystem_access: "需要实际读取、查找或改动文件；仅解释文件格式不算",
  shell_execution: "需要实际运行命令或操作终端；仅展示命令文本不算",
  memory_write: "需要保存或维护用户稳定事实、长期偏好或规则；一次性要求不算",
  scheduler_management: "需要查询、创建或改变计划任务；仅说明时间不算",
  time_lookup: "需要获取当前准确时间；已有固定时间信息不算",
  social_admin: "需要查询或管理账号、联系人、申请或权限；仅讨论社交问题不算",
  conversation_navigation: "需要查找或读取其他可访问会话的上下文",
  chat_delegation: "需要向其他会话转达、询问或委派任务；当前会话回复不算",
  image_generation: "需要生成或编辑图片；查找、下载或查看已有图片不算"
};
const dependencyDescriptions: Record<typeof turnPlannerContextDependencies[number], string> = {
  structured_message_context: "依赖当前消息中引用、转发或媒体对应的内容，需要展开其上下文",
  prior_web_context: "需要此前已浏览网页、搜索结果或页面资源，单独发起新搜索不算",
  prior_shell_context: "需要此前终端任务、命令输出或运行资源，开始新命令不算",
  prior_file_context: "需要此前已定位、读取或生成的文件及内容，单独处理新附件不算",
  prior_chat_context: "需要此前聊天或其他已定位会话中的具体内容"
};
const intentDescriptions: Record<TaskPlannerIntentKind, string> = {
  none: "当前消息不表达对已有任务的操作或续接意图",
  continue_current: "继续执行已有主任务，目标与约束未改变",
  modify_current: "补充、修正或改变主任务的要求，仍属于同一任务",
  pause_current: "明确要求暂缓主任务，任务仍需保留",
  cancel_current: "明确要求停止并放弃主任务；暂停、换话题或礼貌收尾不算取消",
  confirm_completed: "明确确认主任务已经完成；仅询问进度或表达感谢不算完成确认",
  switch_topic: "开始无关交流，但未明确要求创建另一个执行任务或取消主任务",
  start_unrelated_task: "明确提出与主任务不同的新执行任务",
  restore_parked: "明确要求恢复指定的已停放任务",
  unknown: "语义不明确或无法确定与任务的关系；不得猜测取消、完成或恢复"
};

/** The only semantic definitions; chat and native adapters render these same questions. */
export function buildPlannerQuestions(input: PlannerDefinitionInput): PlannerQuestionDefinition[] {
  const definitions: PlannerQuestionDefinition[] = [];
  const needs = input.requirements;
  const choice = (name: string, instructions: string, choices: Array<{ value: string; description: string }>, apply: PlannerQuestionDefinition["apply"], choicePolicy?: "highest_probability") => {
    definitions.push({ question: { name, type: "choice", instructions, choices }, apply, ...(choicePolicy ? { choicePolicy } : {}) });
  };
  const predicate = (name: string, instructions: string, threshold: number, apply: PlannerQuestionDefinition["apply"]) => {
    definitions.push({ question: { name, type: "predicate", instructions, }, threshold, apply });
  };
  if (needs.replyGate || needs.semanticWait) {
    const descriptions: Record<string, string> = {
      reply: "当前有明确问题、指令、直接提及、引用或其他回应需要；不满足等待和无需回复条件时选择此项",
      wait: "当前消息明显只说到一半，预计用户还会补充；不能用来表示无需回复，不能仅因图片、引用或转发文本短而等待",
      no_reply: "群聊当前批次明显不需要机器人回应；明确提及、问题、指令与引用不适用"
    };
    choice("reply", "仅判断是否回应或等待补全，不判断模型档位；基于当前批次与已有上下文独立判断。", getTurnPlannerReplyOptions(needs).map(value => ({ value, description: descriptions[value]! })), (answer, plan) => {
      if (answer.value === "reply" || answer.value === "wait" || answer.value === "no_reply") plan.replyDecision = answer.value;
      plan.waitReason = plan.replyDecision === "wait" ? "unfinished_message" : "none";
    });
  }
  if (needs.modelSelection) {
    choice("model", `${MODEL_SELECTION_INSTRUCTIONS}${input.modeId === "stateful_rp" ? `\n${STATEFUL_RP_MODEL_SELECTION_RULE}` : ""}`, [
      { value: "small", description: MODEL_SELECTION_SMALL_WHEN },
      { value: "large", description: MODEL_SELECTION_LARGE_WHEN }
    ], (answer, plan) => {
      if (answer.value === "small" || answer.value === "large") {
        plan.modelTier = answer.value;
        plan.modelSelectionStatus = "decided";
        if (answer.probabilities) plan.modelSelectionScores = modelSelectionScoresSchema.parse({
          small: answer.probabilities.find(item => item.value === "small")?.probability,
          large: answer.probabilities.find(item => item.value === "large")?.probability,
          confidence: answer.confidence
        });
      }
    }, "highest_probability");
  }
  if (needs.topicSwitch) {
    choice("topic", "判断本轮与近期内容的语义关系，不判断是否取消、完成或恢复任务。", [
      { value: "continue_topic", description: "追问、补充、纠正、引用或省略式续接近期内容；无法明确认定独立新话题时也保留原话题" },
      { value: "new_topic", description: "当前内容与近期话题明显无关且形成新的交流主题；只切换话题，不代表取消旧任务" }
    ], (answer, plan) => { if (answer.value === "new_topic") plan.topicDecision = "new_topic"; });
  }
  if (needs.taskIntent && input.taskContext) {
    const targets = input.taskContext;
    const choices = taskPlannerIntentKinds.filter(kind => kind !== "restore_parked").map(kind => ({ value: kind as string, description: intentDescriptions[kind] }));
    for (const task of targets.parked) choices.push({ value: `restore_parked:${task.taskId}`, description: `明确恢复停放任务 ${task.taskId}：${task.objective}；没有明确目标不选择。` });
    choice("task", "仅根据用户新消息与给定任务上下文判断任务意图；没有明确证据时选择 unknown，不猜测用户要取消、完成或恢复任务。", choices, (answer, plan) => {
      if (typeof answer.value !== "string") return;
      const restoreId = answer.value.startsWith("restore_parked:") ? answer.value.slice("restore_parked:".length) : undefined;
      const kind = restoreId ? "restore_parked" : answer.value as TaskPlannerIntentKind;
      const targetTaskId = restoreId ?? (kind === "none" || kind === "unknown" ? undefined : targets.primary?.taskId);
      plan.taskIntent = { kind, confidence: kind === "unknown" ? "low" : "high", ...(targetTaskId ? { targetTaskId } : {}) };
    });
  }
  if (needs.toolSelection) {
    for (const capability of turnPlannerRequiredCapabilities) predicate(`capability:${capability}`, `当前任务是否很可能需要这项实际能力：${capabilityDescriptions[capability]}？工具可用或任务提到该概念，本身不代表需要调用。`, 0.35, (answer, plan) => { if (answer.value === true) plan.requiredCapabilities.push(capability); });
    for (const dependency of turnPlannerContextDependencies) predicate(`dependency:${dependency}`, `当前任务是否${dependencyDescriptions[dependency]}？缺少新的外部事实不代表依赖已有结果；没有相关材料则否。`, 0.35, (answer, plan) => { if (answer.value === true) plan.contextDependencies.push(dependency); });
    choice("followup", "仅判断当前消息如何续接已有上下文；不要据此假定需要哪种工具。", [
      { value: "none", description: "当前请求内容独立完整，不依赖指代或省略恢复要求" },
      { value: "elliptical", description: "省略主语、对象或要求，需要从近期上下文恢复，例如继续、再查一次" },
      { value: "explicit_reference", description: "明确引用前文中的对象、材料、结果或任务" }
    ], (answer, plan) => { if (answer.value === "none" || answer.value === "elliptical" || answer.value === "explicit_reference") plan.followupMode = answer.value; });
    for (const toolset of input.availableToolsets ?? []) {
      predicate(`toolset:${toolset.id}`, `当前任务是否很可能实际需要工具集 ${toolset.id}？目录说明：${toolset.title}：${toolset.description}。仅讨论该能力、过去使用过或可见，不代表本轮需要；确有需要时宁可多提供必要工具。`, 0.35, (answer, plan) => { if (answer.value === true || answer.value === null) plan.toolsetIds.push(toolset.id); });
      predicate(`reuse:${toolset.id}`, `当前任务是否明确续接近期 ${toolset.id} 工具对应的工作、资源或结果？目录说明：${toolset.title}：${toolset.description}。仅过去调用过而本轮无关，或本轮开始独立新工作则否。`, 0.35, (answer, plan) => { if (answer.value === true) plan.recentDomainReuse.push(toolset.id); });
    }
  }
  if (needs.skillSelection) for (const skill of input.availableSkills ?? []) {
    predicate(`skill:${skill.id}`, `当前任务是否需要采用技能 ${skill.id} 提供的方法？目录说明：${skill.name}：${skill.description}。工具可用、关键词相似或技能存在本身不是加载理由；只选择确实适用的方法，最终最多加载 ${PLANNER_SKILL_LIMIT} 个。`, 0.7, (answer, plan) => { if (answer.value === true) (plan.skillIds ??= []).push(skill.id); });
  }
  return definitions;
}

export function canUseNativePlannerQuestions(definitions: PlannerQuestionDefinition[]): boolean {
  return definitions.length > 0 && definitions.length <= PLANNER_MAX_QUESTIONS && definitions.every(({ question }) => question.type !== "choice" || (question.choices.length >= 2 && question.choices.length <= PLANNER_MAX_CHOICES));
}

/** Probability and confidence remain separate; chat adapters never invent either. */
export function applyPlannerAnswers(input: PlannerDefinitionInput, definitions: PlannerQuestionDefinition[], answers: Map<string, PlannerAnswer>): TurnPlannerResult {
  const plan = createDefaultTurnPlan("规划完成");
  plan.modelSelectionStatus = input.requirements.modelSelection ? "undetermined" : "not_requested";
  plan.undeterminedQuestions = [];
  const scoredSkills: Array<{ id: string; probability: number }> = [];
  for (const definition of definitions) {
    const name = definition.question.name;
    let answer: PlannerAnswer = answers.get(name) ?? { value: null };
    if (definition.question.type === "choice" && definition.choicePolicy === "highest_probability" && answer.value !== null && answer.probabilities) {
      // Declared order breaks ties deterministically: small, then large; the last maximum wins.
      const candidates = definition.question.choices.map(choice => answer.probabilities!.find(item => item.value === choice.value)!);
      const selected = candidates.reduce((best, item) => item.probability >= best.probability ? item : best);
      answer = { ...answer, value: selected.value, probability: selected.probability };
    }
    if (definition.question.type === "choice" && definition.choicePolicy !== "highest_probability" && answer.value !== null && (
      (answer.confidence !== undefined && answer.confidence < PLANNER_ACTION_CONFIDENCE)
      || (answer.probability !== undefined && answer.probability < PLANNER_ACTION_CONFIDENCE)
    )) answer = { ...answer, value: null };
    if (answer.value === null) plan.undeterminedQuestions.push(name);
    definition.apply(answer, plan);
    if (name.startsWith("skill:") && answer.value === true) scoredSkills.push({ id: name.slice(6), probability: answer.probability ?? 1 });
    if (name === "task" && answer.value === null) plan.taskIntent = { kind: "unknown", confidence: "low" };
  }
  plan.skillIds = scoredSkills.sort((left, right) => right.probability - left.probability).slice(0, PLANNER_SKILL_LIMIT).map(item => item.id);
  plan.reason = summarizeTurnPlan(plan);
  return plan;
}

export function summarizeTurnPlan(plan: TurnPlannerResult): string {
  const action = { reply: "回复", wait: "等待消息补全", no_reply: "无需回复" }[plan.replyDecision];
  const model = plan.modelSelectionStatus === "undetermined" ? "，模型档位未判定" : plan.modelTier === "large" ? "，使用完整模型" : "";
  return `${action}${model}${plan.topicDecision === "new_topic" ? "，切换话题" : ""}${plan.undeterminedQuestions?.length ? "，部分判断未确定" : ""}`;
}

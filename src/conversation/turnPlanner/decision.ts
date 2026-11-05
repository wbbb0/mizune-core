import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { DecisionAnswer, DecisionContentPart, DecisionInput, DecisionQuestion } from "#llm/provider/nativeCapabilityTypes.ts";
import { buildTurnPlannerEvidence, buildTurnPlannerInstructions } from "#llm/prompts/turn-planner.prompt.ts";
import { taskPlannerIntentKinds, type TaskPlannerIntentKind } from "../taskTracker/taskTrackerPlannerContext.ts";
import { getTurnPlannerReplyOptions } from "../turnPlannerPolicy.ts";
import { createDefaultTurnPlan } from "./result.ts";
import { turnPlannerContextDependencies, turnPlannerRequiredCapabilities, type PreparedTurnPlannerInput, type TurnPlannerEvaluation, type TurnPlannerInput, type TurnPlannerResult } from "./types.ts";

// Initial operating thresholds: favor replying and tool recall; require stronger
// evidence before suppressing a reply, compressing history or changing a task.
const ACTION_CONFIDENCE = 0.8;
const TOOL_PROBABILITY = 0.35;
const SKILL_PROBABILITY = 0.7;
const MAX_QUESTIONS = 400;

interface PlannerQuestion {
  question: DecisionQuestion;
  apply: (answer: DecisionAnswer, plan: TurnPlannerResult) => void;
}

function buildPlannerQuestions(input: TurnPlannerInput): PlannerQuestion[] {
  const checks: PlannerQuestion[] = [];
  const needs = input.requirements;
  const choice = (name: string, instructions: string, values: string[], apply: (value: string, confidence: number, plan: TurnPlannerResult) => void) => {
    checks.push({
      question: { name, type: "choice", instructions, choices: values.map(value => ({ value })) },
      apply(answer, plan) {
        if (answer.type === "choice" && typeof answer.choice === "string" && values.includes(answer.choice)) {
          const probability = answer.probabilities.find(item => item.value === answer.choice)?.probability ?? 0;
          apply(answer.choice, Math.min(answer.confidence, probability), plan);
        }
      }
    });
  };
  const predicate = (name: string, instructions: string, apply: (probability: number | null, plan: TurnPlannerResult) => void) => {
    checks.push({ question: { name, type: "predicate", instructions }, apply(answer, plan) {
      apply(answer.type === "predicate" ? answer.probability : null, plan);
    } });
  };

  if (needs.modelSelection || needs.replyGate || needs.semanticWait) {
    choice("reply", "按规划规则选择回复方式。wait 仅表示消息明确未说完，不能用它表示无需回复。", getTurnPlannerReplyOptions(needs), (value, confidence, plan) => {
      if (value === "reply_large") plan.replyDecision = "reply_large";
      if ((value === "wait" || value === "no_reply") && confidence >= ACTION_CONFIDENCE) plan.replyDecision = value;
      plan.waitReason = plan.replyDecision === "wait" ? "unfinished_message" : "none";
    });
  }
  if (needs.topicSwitch) {
    choice("topic", "本轮是否与近期消息明显无关？追问、补充、修正和指代续接属于原话题。", ["continue_topic", "new_topic"], (value, confidence, plan) => {
      if (value === "new_topic" && confidence >= ACTION_CONFIDENCE) plan.topicDecision = "new_topic";
    });
  }
  if (needs.taskIntent && input.taskContext) {
    // Intent and target form one category. Separate dependent questions could
    // otherwise select a restore action and an unrelated or nonexistent target.
    const choices: Array<{ value: string; kind: TaskPlannerIntentKind; targetTaskId: string | undefined }> = taskPlannerIntentKinds.filter(kind => kind !== "restore_parked").map(kind => ({ value: kind as string, kind, targetTaskId: input.taskContext?.primary?.taskId }));
    for (const task of input.taskContext.parked) choices.push({ value: `restore_parked:${task.taskId}`, kind: "restore_parked", targetTaskId: task.taskId });
    choice("task", "判断新消息与当前任务的关系。restore_parked: 后的 ID 必须是明确要求恢复的已有任务；不明确时选择 unknown。", choices.map(item => item.value), (value, confidence, plan) => {
      const selected = choices.find(item => item.value === value)!;
      plan.taskIntent = confidence >= ACTION_CONFIDENCE
        ? { kind: selected.kind, confidence: "high", ...(selected.targetTaskId ? { targetTaskId: selected.targetTaskId } : {}) }
        : { kind: "unknown", confidence: "low" };
    });
  }
  if (needs.toolSelection) {
    for (const capability of turnPlannerRequiredCapabilities) {
      predicate(`capability:${capability}`, `本轮很可能需要 ${capability} 能力吗？`, (probability, plan) => {
        if (probability !== null && probability >= TOOL_PROBABILITY) plan.requiredCapabilities.push(capability);
      });
    }
    for (const dependency of turnPlannerContextDependencies) {
      predicate(`dependency:${dependency}`, `本轮是否依赖 ${dependency} 所表示的既有上下文？`, (probability, plan) => {
        if (probability !== null && probability >= TOOL_PROBABILITY) plan.contextDependencies.push(dependency);
      });
    }
    choice("followup", "本轮是独立请求、省略式续接，还是明确引用前文的续接？", ["none", "elliptical", "explicit_reference"], (value, _confidence, plan) => {
      plan.followupMode = value as TurnPlannerResult["followupMode"];
    });
    for (const toolset of input.availableToolsets ?? []) {
      predicate(`toolset:${toolset.id}`, `本轮很可能使用工具集 ${toolset.id} 吗？${toolset.title}：${toolset.description}。按任务需要选择，缺少必要工具比多提供工具代价更高。`, (probability, plan) => {
        // Refusal leaves this candidate available; it never becomes a false answer.
        if (probability === null || probability >= TOOL_PROBABILITY) plan.toolsetIds.push(toolset.id);
      });
      predicate(`reuse:${toolset.id}`, `本轮是否明显续接前文中 ${toolset.id} 工具集对应的工作？没有相关前文则否。`, (probability, plan) => {
        if (probability !== null && probability >= TOOL_PROBABILITY) plan.recentDomainReuse.push(toolset.id);
      });
    }
  }
  if (needs.skillSelection) {
    const selected: Array<{ id: string; probability: number }> = [];
    for (const skill of input.availableSkills ?? []) {
      predicate(`skill:${skill.id}`, `当前任务是否需要加载技能 ${skill.id}？${skill.name}：${skill.description}。工具可用不代表需要加载此技能。`, (probability, plan) => {
        if (probability !== null && probability >= SKILL_PROBABILITY) selected.push({ id: skill.id, probability });
        plan.skillIds = selected.sort((left, right) => right.probability - left.probability).slice(0, 3).map(item => item.id);
      });
    }
  }
  return checks;
}

export function canEvaluateWithDecision(input: TurnPlannerInput): boolean {
  const count = buildPlannerQuestions(input).length;
  return count > 0 && count <= MAX_QUESTIONS;
}

export async function evaluateWithDecision(config: AppConfig, client: LlmClient, input: PreparedTurnPlannerInput, modelRefs: string[], timeoutMs: number): Promise<TurnPlannerEvaluation> {
  const checks = buildPlannerQuestions(input);
  if (!checks.length || checks.length > MAX_QUESTIONS) throw new Error("规划问题数量超出决策接口范围");
  const evidence = buildTurnPlannerEvidence(input);
  const content = typeof evidence.content === "string" ? [{ type: "input_text" as const, text: evidence.content }]
    : evidence.content.flatMap<DecisionContentPart>(part => {
      if (part.type === "text") return [{ type: "input_text" as const, text: part.text }];
      if (part.type === "image_url") return [{ type: "input_image" as const, image_url: part.image_url.url }];
      return [];
    });
  const decisionInput: DecisionInput = [
    { role: "developer", content: buildTurnPlannerInstructions(input) },
    { role: "user", content }
  ];
  const result = await client.decide({
    modelRefOverride: modelRefs,
    timeoutMsOverride: Math.min(timeoutMs, config.llm.decision.timeoutMs),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    skipDebugDump: true,
    input: decisionInput,
    questions: checks.map(check => check.question)
  });
  if (result.answers.length !== checks.length) throw new Error("规划决策答案数量不匹配");
  const plan = createDefaultTurnPlan("原生决策完成");
  for (const [index, check] of checks.entries()) {
    const answer = result.answers[index]!;
    if (answer.name !== check.question.name) throw new Error("规划决策答案名称不匹配");
    check.apply(answer, plan);
  }
  const replyLabel = { reply_small: "回复", reply_large: "使用完整模型回复", wait: "等待消息补全", no_reply: "无需回复" }[plan.replyDecision];
  const refused = result.answers.some(answer => answer.type === "refusal");
  plan.reason = `${replyLabel}${plan.topicDecision === "new_topic" ? "，切换话题" : ""}${refused ? "，部分判断被拒绝" : ""}`;
  return { plan, usage: result.usage };
}

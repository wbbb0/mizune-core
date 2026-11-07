import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { DecisionContentPart, DecisionInput } from "#llm/provider/nativeCapabilityTypes.ts";
import { buildTurnPlannerEvidence, buildTurnPlannerInstructions } from "#llm/prompts/turn-planner.prompt.ts";
import { applyPlannerAnswers, buildPlannerQuestions, canUseNativePlannerQuestions, type PlannerAnswer } from "./definitions.ts";
import type { PreparedTurnPlannerInput, TurnPlannerEvaluation, TurnPlannerInput } from "./types.ts";

export function canEvaluateWithDecision(input: TurnPlannerInput): boolean {
  return canUseNativePlannerQuestions(buildPlannerQuestions(input));
}

export async function evaluateWithDecision(config: AppConfig, client: LlmClient, input: PreparedTurnPlannerInput, modelRefs: string[], timeoutMs: number): Promise<TurnPlannerEvaluation> {
  const definitions = buildPlannerQuestions(input);
  if (!canUseNativePlannerQuestions(definitions)) throw new Error("规划问题或选项数量超出决策接口范围");
  const evidence = buildTurnPlannerEvidence(input);
  const content = typeof evidence.content === "string" ? [{ type: "input_text" as const, text: evidence.content }]
    : evidence.content.flatMap<DecisionContentPart>(part => {
      if (part.type === "text") return [{ type: "input_text" as const, text: part.text }];
      if (part.type === "image_url") return [{ type: "input_image" as const, image_url: part.image_url.url }];
      return [];
    });
  const decisionInput: DecisionInput = [
    { role: "developer", content: buildTurnPlannerInstructions(input) }, { role: "user", content }
  ];
  const result = await client.decide({
    modelRefOverride: modelRefs, timeoutMsOverride: Math.min(timeoutMs, config.llm.decision.timeoutMs),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}), skipDebugDump: true,
    input: decisionInput, questions: definitions.map(definition => definition.question)
  });
  if (result.answers.length !== definitions.length) throw new Error("规划决策答案数量不匹配");
  const answers = new Map<string, PlannerAnswer>();
  for (const [index, definition] of definitions.entries()) {
    const answer = result.answers[index]!;
    if (answer.name !== definition.question.name) throw new Error("规划决策答案名称不匹配");
    if (answer.type === "refusal") answers.set(answer.name, { value: null });
    else if (answer.type === "predicate" && definition.question.type === "predicate") answers.set(answer.name, { value: answer.probability >= definition.threshold!, probability: answer.probability });
    else if (answer.type === "choice" && definition.question.type === "choice" && typeof answer.choice === "string") {
      const probability = answer.probabilities.find(item => item.value === answer.choice)?.probability ?? 0;
      answers.set(answer.name, { value: answer.choice, probability, confidence: answer.confidence });
    } else throw new Error("规划决策答案类型不匹配");
  }
  return { plan: applyPlannerAnswers(input, definitions, answers), usage: result.usage };
}

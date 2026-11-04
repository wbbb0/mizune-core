import type { LlmProviderRequestContext } from "./providerTypes.ts";
import type { DecisionAnswer, DecisionQuestion, LlmDecideParams, LlmDecideResult } from "./nativeCapabilityTypes.ts";
import { isObject, nativeUsage, readNativeBody, requestNativeCapability } from "./nativeCapabilityHttp.ts";

export function validateDecisionQuestions(questions: DecisionQuestion[]): void {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 400) throw new Error("决策问题数量须为 1–400");
  const names = new Set<string>();
  for (const question of questions) {
    if (!question || typeof question.name !== "string" || !question.name.trim() || names.has(question.name)) throw new Error("每个决策问题必须有唯一的非空名称");
    names.add(question.name);
    if ((typeof question.instructions !== "string" || !question.instructions.trim()) && (!Array.isArray(question.instructions) || !question.instructions.length)) throw new Error("决策问题缺少判断说明");
    if (question.type === "predicate") continue;
    if (question.type === "choice") {
      const choices = question.choices;
      if (!Array.isArray(choices) || choices.length < 2 || choices.length > 255 || choices.some(item => !item || !["string", "boolean"].includes(typeof item.value)) || new Set(choices.map(item => JSON.stringify(item.value))).size !== choices.length) throw new Error("选择决策必须有 2–255 个不重复的字符串或布尔选项");
    } else if (question.type === "score") {
      const levels = question.levels;
      if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10 || levels.some(item => !item || typeof item.label !== "string" || !item.label.trim())) throw new Error("评分决策必须有 2–10 个有序等级");
    } else throw new Error("未知决策问题类型");
  }
}

export async function requestOpenAiDecision(context: LlmProviderRequestContext, params: LlmDecideParams): Promise<LlmDecideResult> {
  if (!context.modelProfile.decision) throw new Error("模型未配置决策用途");
  validateDecisionQuestions(params.questions);
  if ((typeof params.input !== "string" || !params.input.trim()) && (!Array.isArray(params.input) || !params.input.length)) throw new Error("决策输入不能为空");
  return requestNativeCapability(context, params, "/decisions", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: context.model, input: params.input, questions: params.questions })
  }, async response => {
    const payload: unknown = JSON.parse((await readNativeBody(response, 4 * 1024 * 1024)).toString("utf8"));
    if (!isObject(payload) || !Array.isArray(payload.answers) || payload.answers.length !== params.questions.length) throw new Error("OpenAI 决策响应的答案数量不匹配");
    const answers = payload.answers.map((answer: unknown, index: number) => validateDecisionAnswer(answer, params.questions[index]!));
    return { answers, usage: nativeUsage(context, payload.usage) };
  });
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateDecisionAnswer(value: unknown, question: DecisionQuestion): DecisionAnswer {
  if (!isObject(value) || value.name !== question.name) throw new Error("OpenAI 决策响应的问题名称不匹配");
  if (value.type === "refusal") return { name: question.name, type: "refusal" };
  if (value.type !== question.type) throw new Error("OpenAI 决策响应的答案类型不匹配");
  if (question.type === "predicate") {
    if (!isProbability(value.probability)) throw new Error("OpenAI 决策响应包含无效概率");
    return { name: question.name, type: "predicate", probability: value.probability };
  }
  if (!isProbability(value.confidence) || !Array.isArray(value.probabilities)) throw new Error("OpenAI 决策响应缺少有效概率分布");
  const probabilities = value.probabilities;
  if (question.type === "choice") {
    if (!question.choices.some(item => item.value === value.choice)) throw new Error("OpenAI 决策响应选择了未声明的选项");
    if (probabilities.length !== question.choices.length || probabilities.some(item => !isObject(item) || !isProbability(item.probability) || !question.choices.some(choice => choice.value === item.value)) || new Set(probabilities.map(item => JSON.stringify(item.value))).size !== probabilities.length) throw new Error("OpenAI 决策响应包含无效选项分布");
  } else {
    if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > question.levels.length - 1) throw new Error("OpenAI 决策响应包含无效评分");
    if (probabilities.length !== question.levels.length || probabilities.some(item => !isObject(item) || !isProbability(item.probability) || !Number.isInteger(item.value) || question.levels[item.value as number]?.label !== item.label) || new Set(probabilities.map(item => item.value)).size !== probabilities.length) throw new Error("OpenAI 决策响应包含无效评分分布");
  }
  // The provider contract is validated above; preserve documented distribution details.
  return value as unknown as DecisionAnswer;
}

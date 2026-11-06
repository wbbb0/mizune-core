import { isObject } from "../nativeCapabilityHttp.ts";
import type { DecisionAnswer, LlmDecideParams } from "../nativeCapabilityTypes.ts";
import { validateDecisionAnswer } from "./validation.ts";

/** Preserve typed choice identities with opaque indices, never string coercion of values. */
export function encodeSystemOne(params: LlmDecideParams) {
  const questions: Record<string, { type: "noul"; instructions: string } | { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "score"; instructions: string; criteria: string[] }> = {};
  for (const [index, question] of params.questions.entries()) {
    if (typeof question.instructions !== "string") throw new Error("System One 当前仅支持文本问题说明");
    questions[`q${index}`] = question.type === "predicate"
      ? { type: "noul", instructions: question.instructions }
      : question.type === "choice"
        ? { type: "choice", instructions: question.instructions, criteria: Object.fromEntries(question.choices.map((item, i) => [`c${i}`, JSON.stringify({ value: item.value, description: item.description })])) }
        : { type: "score", instructions: question.instructions, criteria: question.levels.map(item => item.description ? `${item.label}：${item.description}` : item.label) };
  }
  if (typeof params.input !== "string" && params.input.some(message => typeof message.content !== "string" && message.content.some(part => part.type !== "input_text" && part.type !== "input_json" && part.type !== "output_text" && part.type !== "refusal"))) {
    throw new Error("System One 当前不支持此多模态输入，请使用文本或 JSON");
  }
  return { state: typeof params.input === "string" ? params.input : JSON.stringify(params.input), questions };
}

export function decodeSystemOne(raw: unknown, params: LlmDecideParams): DecisionAnswer[] {
  if (!isObject(raw) || Object.keys(raw).length !== params.questions.length) throw new Error("System One 答案数量不匹配");
  return params.questions.map((question, index) => {
    const answer = raw[`q${index}`];
    if (!isObject(answer)) throw new Error("System One 缺少答案");
    const name = question.name;
    if (answer.type === "refusal") return { name, type: "refusal" };
    if (question.type === "predicate") {
      if (answer.type !== "noul") throw new Error("System One 答案类型不匹配");
      return validateDecisionAnswer({ name, type: "predicate", probability: answer.noul }, question);
    }
    if (answer.type !== question.type || !isObject(answer.probabilities)) throw new Error("System One 缺少完整概率分布");
    const distribution = answer.probabilities;
    const keys = question.type === "choice" ? question.choices.map((_, i) => `c${i}`) : question.levels.map((_, i) => String(i));
    if (Object.keys(distribution).length !== keys.length || keys.some(key => typeof distribution[key] !== "number" || !Number.isFinite(distribution[key]) || (distribution[key] as number) < 0 || (distribution[key] as number) > 1)) throw new Error("System One 概率分布无效");
    const probabilities = keys.map(key => distribution[key] as number);
    if (Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.01) throw new Error("System One 概率分布未归一化");
    if (question.type === "choice") {
      const selected = keys.indexOf(String(answer.choice));
      if (selected < 0) throw new Error("System One 选项无效");
      return validateDecisionAnswer({ name, type: "choice", choice: question.choices[selected]!.value, confidence: answer.confidence, probabilities: question.choices.map((item, i) => ({ value: item.value, probability: probabilities[i] })) }, question);
    }
    return validateDecisionAnswer({ name, type: "score", score: answer.score, confidence: answer.confidence, probabilities: question.levels.map((item, i) => ({ value: i, label: item.label, probability: probabilities[i] })) }, question);
  });
}


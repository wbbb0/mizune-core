import type { LlmGenerateParams } from "../../src/llm/llmClient.ts";
import { buildPlannerQuestions, type PlannerDefinitionInput } from "../../src/conversation/turnPlanner/definitions.ts";

export function plannerChatFixture(input: PlannerDefinitionInput, overrides: Record<string, string | boolean | null> = {}, taskBasis = "当前任务要求明确，按已有上下文判断。") {
  return JSON.stringify({ task_basis: taskBasis, ...Object.fromEntries(buildPlannerQuestions(input).map(({ question }) => [question.name,
    Object.prototype.hasOwnProperty.call(overrides, question.name) ? overrides[question.name] : question.type === "choice" ? question.choices[0]!.value : false])) });
}

/** Fill generated fields for protocol mocks; assertions still control each semantic answer. */
export function completePlannerChatFixture(params: LlmGenerateParams, raw?: string): string {
  const system = String(params.messages[0]?.content ?? "");
  const section = system.match(/%%llmbot:section name="planner_output"\n([\s\S]*?)%%llmbot:\/section/)?.[1] ?? "";
  const names = section.split("\n").filter(line => /^[a-z][a-z0-9_:.-]*$/u.test(line));
  const defaults: Record<string, string | boolean | null> = { reply: "reply", model: "small", topic: "continue_topic", task: "none", followup: "none" };
  let fields: Record<string, unknown> = {};
  if (raw !== undefined) {
    try { fields = JSON.parse(raw); } catch { return raw; }
  }
  return JSON.stringify({ task_basis: fields.task_basis ?? "当前任务要求明确，按已有上下文判断。", ...Object.fromEntries(names.map(name => [name,
    Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : defaults[name] ?? false])) });
}

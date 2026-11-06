import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmGenerateParams } from "#llm/llmClient.ts";
import { buildTurnPlannerPrompt, buildTurnPlannerResponseFormat, estimateTurnPlannerOutputTokens } from "#llm/prompts/turn-planner.prompt.ts";
import { resolveTurnPlannerOutputTokenLimit } from "../turnPlannerPolicy.ts";
import { applyPlannerAnswers, buildPlannerQuestions, PLANNER_TASK_BASIS_MAX_LENGTH, type PlannerAnswer, type PlannerDefinitionInput } from "./definitions.ts";
import type { PreparedTurnPlannerInput, TurnPlannerResult, TurnPlannerEvaluation } from "./types.ts";

export async function evaluateWithChat(config: AppConfig, client: LlmClient, input: PreparedTurnPlannerInput, modelRefs: string[], timeoutMs: number): Promise<TurnPlannerEvaluation> {
  const result = await client.generate(buildTurnPlannerChatRequest(config, client, input, modelRefs, timeoutMs));
  const plan = parseStructuredPlannerResult(result.text.trim(), input);
  if (!plan) throw new Error("规划输出协议无效");
  return { plan: { ...plan, ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}) }, ...(result.usage ? { usage: result.usage } : {}) };
}

/** Shared by production and opt-in format probes, including output budget. */
export function buildTurnPlannerChatRequest(
  config: AppConfig,
  client: Partial<Pick<LlmClient, "supportsStructuredOutput">>,
  input: PreparedTurnPlannerInput,
  modelRefs: string[],
  timeoutMs: number
): LlmGenerateParams {
  const responseFormat = client.supportsStructuredOutput?.(modelRefs) ? buildTurnPlannerResponseFormat(input) : undefined;
  const maxOutputTokens = resolveTurnPlannerOutputTokenLimit(config, modelRefs, estimateTurnPlannerOutputTokens(input));
  return {
    ...(responseFormat ? { responseFormat } : {}), modelRefOverride: modelRefs, timeoutMsOverride: timeoutMs,
    ...(maxOutputTokens != null ? { maxOutputTokensOverride: maxOutputTokens } : {}),
    enableThinkingOverride: config.llm.turnPlanner.enableThinking, preferNativeNoThinkingChatEndpoint: true,
    skipDebugDump: true, ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    messages: buildTurnPlannerPrompt(input)
  };
}

/** The generated JSON protocol is the only accepted chat output, with task basis first. */
export function parseStructuredPlannerResult(raw: string, input: PlannerDefinitionInput): TurnPlannerResult | null {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const fields = decoded as Record<string, unknown>;
  const definitions = buildPlannerQuestions(input);
  const expected = ["task_basis", ...definitions.map(({ question }) => question.name)];
  const keys = topLevelKeys(raw);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (typeof fields.task_basis !== "string" || !fields.task_basis.trim() || [...fields.task_basis].length > PLANNER_TASK_BASIS_MAX_LENGTH) return null;
  const answers = new Map<string, PlannerAnswer>();
  for (const { question } of definitions) {
    const value = fields[question.name];
    if (value === null) { answers.set(question.name, { value: null }); continue; }
    if (question.type === "predicate" ? typeof value !== "boolean" : !question.choices.some(choice => choice.value === value)) return null;
    answers.set(question.name, { value: value as string | boolean });
  }
  const plan = applyPlannerAnswers(input, definitions, answers);
  plan.taskBasis = fields.task_basis.trim();
  return plan;
}

/** JSON.parse discards duplicate object keys; retain the actual top-level generation order. */
function topLevelKeys(raw: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let start = -1;
  let escaped = false;
  let keyExpected = false;
  let capture = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (start >= 0) {
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') {
        if (capture) keys.push(JSON.parse(raw.slice(start, index + 1)) as string);
        start = -1;
        capture = false;
      }
      continue;
    }
    if (character === '"') { start = index; capture = depth === 1 && keyExpected; keyExpected = false; }
    else if (character === "{" || character === "[") { depth++; if (depth === 1) keyExpected = true; }
    else if (character === "}" || character === "]") depth--;
    else if (character === "," && depth === 1) keyExpected = true;
  }
  return keys;
}

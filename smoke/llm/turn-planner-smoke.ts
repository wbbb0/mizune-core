import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../../src/config/config.ts";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { getModelRefsForRole } from "../../src/llm/shared/modelRouting.ts";
import { resolveTurnPlannerOutputTokenLimit } from "../../src/conversation/turnPlannerPolicy.ts";
import { estimateTurnPlannerOutputTokens } from "../../src/llm/prompts/turn-planner.prompt.ts";
import { evaluateWithDecision } from "../../src/conversation/turnPlanner/decision.ts";
import {
  parsePlannerSmokeOptions, buildPlannerSmokeInput, buildPlannerSmokeChatRequest, parsePlannerSmokeChatOutput,
  scorePlannerSmokeResult, summarizePlannerSmokeResults, type PlannerSmokeResult
} from "./turn-planner-smoke-support.ts";

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let phase = "invalid_arguments";

async function main(): Promise<void> {
  const options = parsePlannerSmokeOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("用法：npm run smoke:llm:planner -- [--config-dir 路径] [--instance 实例] [--model-ref 供应商/模型] [--backend chat|decision] [--compare | --mode task_basis|direct|short_basis] [--case 合成用例ID,ID] [--repeat 1至20] [--timeout-ms 30000] [--list]\n");
    return;
  }
  if (options.list) {
    for (const item of options.selectedCases) write({ caseId: item.id, expectedTier: item.expectedTier });
    return;
  }
  phase = "configuration_failed";
  // Config warnings can contain local paths or invalid input values. Count without printing them.
  const emitWarning = process.emitWarning;
  let configWarningCount = 0;
  process.emitWarning = (() => { configWarningCount++; }) as typeof process.emitWarning;
  let config;
  try {
    const env = { ...process.env };
    delete env.CONFIG_INSTANCE_FILE;
    if (options.configDir) env.CONFIG_DIR = options.configDir;
    if (options.instance) env.CONFIG_INSTANCE = options.instance;
    config = loadConfig(env);
  } finally {
    process.emitWarning = emitWarning;
  }
  const temporary = await mkdtemp(join(tmpdir(), "planner-smoke-"));
  try {
    config.dataDir = temporary;
    config.llm.enabled = true;
    config.llm.debugDump.enabled = false;
    config.logIncludeConversationContent = false;
    config.llm.turnPlanner.enableThinking = false;
    config.llm.turnPlanner.timeoutMs = options.timeoutMs;
    config.llm.decision.timeoutMs = options.timeoutMs;
    const modelRef = options.modelRef ?? getModelRefsForRole(config, options.backend === "decision" ? "decision" : "turn_planner")[0];
    const client = new LlmClient(config, pino({ level: "silent" }));
    phase = "model_unavailable";
    if (!modelRef || (options.backend === "decision" ? !client.isCapabilityConfigured("decision", [modelRef]) : !client.isConfigured([modelRef]))) throw new Error("无可用模型");
    if (options.backend === "chat" && resolveTurnPlannerOutputTokenLimit(config, [modelRef]) === undefined) {
      phase = "thinking_cannot_be_disabled";
      throw new Error("模型未声明可关闭思考");
    }
    const results: PlannerSmokeResult[] = [];
    write({ event: "planner_smoke_started", backend: options.backend, modelRef, modes: options.modes, caseCount: options.selectedCases.length, repeat: options.repeat, configWarningCount });
    for (const mode of options.modes) for (let iteration = 1; iteration <= options.repeat; iteration++) for (const item of options.selectedCases) {
      const input = buildPlannerSmokeInput(item);
      input.abortSignal = AbortSignal.timeout(options.timeoutMs);
      const startedAt = Date.now();
      let result: PlannerSmokeResult;
      try {
        if (options.backend === "decision") {
          const evaluated = await evaluateWithDecision(config, client, input, [modelRef], options.timeoutMs);
          result = scorePlannerSmokeResult({ backend: options.backend, mode, item, iteration, modelRef,
            plan: evaluated.plan, ...(evaluated.usage ? { usage: evaluated.usage } : {}), elapsedMs: Date.now() - startedAt });
        } else {
          const request = buildPlannerSmokeChatRequest(input, mode);
          const response = await client.generate({ modelRefOverride: [modelRef], timeoutMsOverride: options.timeoutMs,
            enableThinkingOverride: false, preferNativeNoThinkingChatEndpoint: true, skipDebugDump: true,
            maxOutputTokensOverride: resolveTurnPlannerOutputTokenLimit(config, [modelRef], estimateTurnPlannerOutputTokens(input))!,
            ...(client.supportsStructuredOutput([modelRef]) ? { responseFormat: request.responseFormat } : {}),
            messages: request.messages, abortSignal: input.abortSignal });
          result = scorePlannerSmokeResult({ backend: options.backend, mode, item, iteration, modelRef, usage: response.usage,
            plan: parsePlannerSmokeChatOutput(response.text, input, mode), elapsedMs: Date.now() - startedAt });
        }
      } catch {
        result = scorePlannerSmokeResult({ backend: options.backend, mode, item, iteration, modelRef, plan: null,
          elapsedMs: Date.now() - startedAt, requestFailed: true });
      }
      results.push(result);
      write({ event: "planner_smoke_case", ...result });
    }
    for (const mode of options.modes) write({ event: "planner_smoke_summary", backend: options.backend, modelRef, mode,
      ...summarizePlannerSmokeResults(results.filter(item => item.mode === mode)) });
    if (results.some(item => !item.passed)) process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

void main().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: "planner_smoke_error", code: phase })}\n`);
  process.exitCode = 1;
});

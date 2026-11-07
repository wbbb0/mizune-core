import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmUsage } from "#llm/llmClient.ts";
import { foldMessageForModel } from "#messages/modelMessageProjection.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { getTurnPlannerReasons } from "./turnPlannerPolicy.ts";
import { prepareTurnPlannerContext, type TurnPlannerMediaServices } from "./turnPlanner/context.ts";
import { evaluateWithChat } from "./turnPlanner/chat.ts";
import { canEvaluateWithDecision, evaluateWithDecision } from "./turnPlanner/decision.ts";
import { createDefaultTurnPlan, normalizeTurnPlan } from "./turnPlanner/result.ts";
import type { PreparedTurnPlannerInput, TurnPlannerBackend, TurnPlannerInput, TurnPlannerMetrics, TurnPlannerResult } from "./turnPlanner/types.ts";

/** Coordinates one planning budget; protocol adapters never execute conversation actions. */
export class TurnPlanner {
  private readonly media: TurnPlannerMediaServices;

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    chatFileStore: TurnPlannerMediaServices["chatFileStore"],
    mediaVisionService: TurnPlannerMediaServices["mediaVisionService"],
    private readonly logger: Logger,
    mediaCaptionService?: TurnPlannerMediaServices["mediaCaptionService"]
  ) {
    this.media = { chatFileStore, mediaVisionService, ...(mediaCaptionService ? { mediaCaptionService } : {}) };
  }

  private decisionModelRefs(): string[] {
    const refs = getModelRefsForRole(this.config, "decision");
    return refs.length > 0 && this.llmClient.isCapabilityConfigured("decision", refs) ? refs : [];
  }

  isEnabled(): boolean {
    return this.config.llm.enabled && this.config.llm.turnPlanner.enabled
      && (this.decisionModelRefs().length > 0 || getModelRefsForRole(this.config, "turn_planner").length > 0);
  }

  async decide(originalInput: TurnPlannerInput): Promise<TurnPlannerResult> {
    originalInput.abortSignal?.throwIfAborted();
    if (!this.isEnabled() || getTurnPlannerReasons(originalInput.requirements).length === 0) {
      return createDefaultTurnPlan("未启用规划或无需判断");
    }
    const startedAt = Date.now();
    const deadline = startedAt + this.config.llm.turnPlanner.timeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error("轮次规划超时")), this.config.llm.turnPlanner.timeoutMs);
    const signal = AbortSignal.any([timeoutController.signal, ...(originalInput.abortSignal ? [originalInput.abortSignal] : [])]);
    const input: TurnPlannerInput = {
      ...originalInput,
      abortSignal: signal,
      recentMessages: originalInput.recentMessages.slice(-this.config.llm.turnPlanner.recentMessageCount),
      batchMessages: originalInput.batchMessages.map(foldMessageForModel)
    };
    const chatRefs = getModelRefsForRole(this.config, "turn_planner");
    const decisionRefs = this.decisionModelRefs();
    let backend: TurnPlannerBackend = decisionRefs.length > 0 && canEvaluateWithDecision(input) ? "decision" : "chat";
    let modelRef = (backend === "decision" ? decisionRefs : chatRefs)[0];
    let fallbackReason: TurnPlannerMetrics["fallbackReason"] = decisionRefs.length > 0 && backend === "chat" ? "question_limit" : undefined;
    let prepared: PreparedTurnPlannerInput | undefined;
    const contexts = new Map<boolean, PreparedTurnPlannerInput>();
    let mediaPreparationMs = 0;
    let generationMs = 0;
    let unknownUsage = false;
    const usages: LlmUsage[] = [];
    const remainingMs = () => {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("轮次规划超时");
      return remaining;
    };
    const metrics = (): TurnPlannerMetrics => {
      const sum = (key: "inputTokens" | "outputTokens" | "cachedTokens") =>
        unknownUsage || !usages.length || usages.some(usage => usage[key] == null) ? null : usages.reduce((total, usage) => total + usage[key]!, 0);
      return {
        backend, ...(modelRef ? { modelRef } : {}), ...(fallbackReason ? { fallbackReason } : {}),
        durationMs: Date.now() - startedAt, mediaPreparationMs, generationMs,
        inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cachedTokens: sum("cachedTokens"),
        mediaCaptionCount: prepared?.mediaCaptions.length ?? 0,
        emojiInputCount: prepared?.visualInputs.filter(item => item.kind === "emoji").length ?? 0,
        imageInputCount: prepared?.visualInputs.filter(item => item.kind === "image").length ?? 0
      };
    };
    const evaluate = async (selected: TurnPlannerBackend) => {
      backend = selected;
      const refs = selected === "decision" ? decisionRefs : chatRefs;
      modelRef = refs[0];
      if (!refs.length) throw new Error("未配置轮次规划模型");
      const supportsVision = selected === "decision" || refs.every(ref => getPrimaryModelProfile(this.config, ref)?.chat?.capabilities.supportsVision === true);
      prepared = contexts.get(supportsVision);
      if (!prepared) {
        const preparingAt = Date.now();
        try {
          prepared = await awaitPlannerTask(prepareTurnPlannerContext(input, supportsVision, this.media, this.logger), signal);
          contexts.set(supportsVision, prepared);
        } finally { mediaPreparationMs += Date.now() - preparingAt; }
      }
      const generatingAt = Date.now();
      try {
        const timeoutMs = remainingMs();
        const result = await awaitPlannerTask(selected === "decision"
          ? evaluateWithDecision(this.config, this.llmClient, prepared, refs, timeoutMs)
          : evaluateWithChat(this.config, this.llmClient, prepared, refs, timeoutMs), signal);
        signal.throwIfAborted();
        if (result.usage) {
          usages.push(result.usage);
          modelRef = result.usage.modelRef ?? modelRef;
        } else unknownUsage = true;
        return result.plan;
      } catch (error) {
        unknownUsage = true;
        throw error;
      } finally { generationMs += Date.now() - generatingAt; }
    };

    try {
      let plan: TurnPlannerResult;
      try {
        plan = await evaluate(backend);
      } catch (error) {
        signal.throwIfAborted();
        if (backend !== "decision" || !chatRefs.length) throw error;
        fallbackReason = "decision_failed";
        this.logger.warn({ sessionId: input.sessionId, err: error }, "turn_planner_decision_failed");
        plan = await evaluate("chat");
      }
      const result = { ...normalizeTurnPlan(plan, input, prepared!.batchAnalysis, this.config, this.logger), metrics: metrics() };
      this.logger.info({ sessionId: input.sessionId, callReasons: getTurnPlannerReasons(input.requirements), ...result.metrics,
        replyDecision: result.replyDecision, modelTier: result.modelTier, modelSelectionStatus: result.modelSelectionStatus, undeterminedQuestions: result.undeterminedQuestions, topicDecision: result.topicDecision, toolsetIds: result.toolsetIds,
        ...(result.taskIntent ? { taskIntent: result.taskIntent.kind, taskIntentConfidence: result.taskIntent.confidence } : {}), reason: result.reason
      }, "turn_planner_decided");
      if (result.metrics.durationMs >= 3000) {
        this.logger.warn({ sessionId: input.sessionId, backend, modelRef, durationMs: result.metrics.durationMs }, "turn_planner_slow");
      }
      return result;
    } catch (error) {
      originalInput.abortSignal?.throwIfAborted();
      this.logger.warn({ sessionId: input.sessionId, ...metrics(), callReasons: getTurnPlannerReasons(input.requirements), err: error }, "turn_planner_llm_failed");
      return { ...createDefaultTurnPlan("规划失败，继续回复"), modelSelectionStatus: input.requirements.modelSelection ? "undetermined" : "not_requested", metrics: metrics() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Release callers promptly even when a media implementation cannot cancel its work. */
async function awaitPlannerTask<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([task, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

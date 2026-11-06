import type { LlmToolCall } from "#llm/llmClient.ts";

export type GenerationModelTier = "small" | "large";

export interface ToolCallModelSource {
  modelRef: string | null;
  tier: GenerationModelTier;
}

export interface ModelPolicyRequirement {
  tier: GenerationModelTier;
  reason: string;
}

interface GenerationModelPolicyOptions {
  largeModelRefs: readonly string[];
  matchesLargeModel?: (modelRef: string) => boolean;
  requestUpgrade: (input: { toolName: string; reason: string; sourceModelRef: string | null; sourceTier: GenerationModelTier | "unknown" }) => boolean;
}

/** A route change never authorizes calls already proposed by the previous model. */
export class GenerationModelPolicy {
  private readonly sources = new Map<string, ToolCallModelSource>();

  constructor(private readonly options: GenerationModelPolicyOptions) {}

  capture(calls: readonly LlmToolCall[], modelRef: string | null, tier: GenerationModelTier): void {
    this.sources.clear();
    for (const call of calls) this.sources.set(call.id, { modelRef, tier });
  }

  authorize(call: LlmToolCall, requirement: ModelPolicyRequirement): string | null {
    if (requirement.tier === "small") return null;
    const source = this.sources.get(call.id);
    if (source?.tier === "large" && source.modelRef && (this.options.matchesLargeModel?.(source.modelRef)
      ?? this.options.largeModelRefs.includes(source.modelRef))) return null;
    const upgraded = this.options.requestUpgrade({
      toolName: call.function.name,
      reason: requirement.reason,
      sourceModelRef: source?.modelRef ?? null,
      sourceTier: source?.tier ?? "unknown"
    });
    return JSON.stringify({
      ok: false,
      executed: false,
      deferred: upgraded,
      code: upgraded ? "model_policy_deferred" : "model_policy_unavailable",
      requiredModelTier: "large",
      message: upgraded
        ? "本次操作尚未执行，后续请求已使用完整模型路由。请根据原始任务与已有结果重新核查作用范围及参数，再重新提出操作；不要重复已成功执行的动作。"
        : "本次操作尚未执行：需要完整模型核查，但当前不能切换到可用的完整模型路由。请说明当前无法完成的部分，不要改用其他工具绕过或反复重试。"
    });
  }
}

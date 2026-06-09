import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import { parseJsonObjectFromText } from "#llm/shared/jsonObjectExtraction.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { normalizeModelRefs } from "#llm/shared/modelProfiles.ts";

export interface StructuredSuggestionResult {
  ok: boolean;
  value: Record<string, unknown>;
  rawAnswer: string;
  modelRef: string;
  error?: string;
}

export class StructuredSuggestionService {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: Pick<LlmClient, "generate" | "isConfigured">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    const modelRefs = this.resolveModelRefs();
    return this.config.llm.enabled
      && this.config.llm.structuredSuggestion.enabled
      && modelRefs.length > 0
      && this.llmClient.isConfigured(modelRefs);
  }

  async suggestObject(input: {
    taskName: string;
    instruction: string;
    context: Record<string, unknown>;
    outputContract: string;
    abortSignal?: AbortSignal;
  }): Promise<StructuredSuggestionResult> {
    const modelRefs = this.resolveModelRefs();
    if (!this.isEnabled()) {
      return {
        ok: false,
        value: {},
        rawAnswer: "",
        modelRef: normalizeModelRefs(modelRefs)[0] ?? "unknown",
        error: "structured_suggestion_model_not_configured"
      };
    }

    try {
      const result = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        timeoutMsOverride: this.config.llm.structuredSuggestion.timeoutMs,
        enableThinkingOverride: this.config.llm.structuredSuggestion.enableThinking,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        messages: buildStructuredSuggestionPrompt(input)
      });
      const rawAnswer = result.text.trim();
      const parsed = parseJsonObjectFromText(rawAnswer);
      const modelRef = result.usage.modelRef ?? normalizeModelRefs(modelRefs)[0] ?? "unknown";
      if (!parsed) {
        return {
          ok: false,
          value: {},
          rawAnswer,
          modelRef,
          error: "json_parse_failed"
        };
      }
      return {
        ok: true,
        value: parsed.value,
        rawAnswer,
        modelRef
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ taskName: input.taskName, error: message }, "structured_suggestion_failed");
      return {
        ok: false,
        value: {},
        rawAnswer: "",
        modelRef: normalizeModelRefs(modelRefs)[0] ?? "unknown",
        error: message
      };
    }
  }

  private resolveModelRefs(): string[] {
    return getModelRefsForRole(this.config, "main_small");
  }
}

function buildStructuredSuggestionPrompt(input: {
  taskName: string;
  instruction: string;
  context: Record<string, unknown>;
  outputContract: string;
}): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是低成本结构化建议器，负责根据给定上下文生成可编辑的 JSON 建议。",
        "只根据输入素材生成合理建议；可以补全常识性细节，但不要覆盖或否定已经明确的信息。",
        "输出必须严格是一个 JSON object，不输出 Markdown、解释、推理过程或额外文本。",
        "字段名、数组结构和数据类型必须遵守用户提供的输出契约。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `task_name: ${input.taskName}`,
        "instruction:",
        input.instruction,
        "output_contract:",
        input.outputContract,
        "context_json:",
        JSON.stringify(input.context)
      ].join("\n")
    }
  ];
}

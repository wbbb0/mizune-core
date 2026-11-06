import { supportsProviderDecision } from "#llm/provider/providerRegistry.ts";
import { buildDecisionToolInput } from "../core/decisionToolInput.ts";
import type { AppConfig } from "#config/config.ts";
import { resolveModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { DecisionQuestion, SpeechFormat } from "#llm/provider/nativeCapabilityTypes.ts";
import { validateDecisionQuestions } from "#llm/provider/decision/validation.ts";
import { buildChatFileHandleResultFromContext } from "../core/chatFileHandle.ts";
import { chatFileListPolicy, keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { getStringArg, getNumberArg } from "../core/toolArgHelpers.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";

export function isSpeechGenerationAvailable(config: AppConfig): boolean {
  return config.llm.enabled && config.llm.speechGeneration.enabled && config.chatFiles.enabled
    && resolveModelRefsForRole(config, "speech_generator").acceptedModelRefs.some(ref => config.llm.providers[config.llm.models[ref]!.provider]?.type === "openai");
}

export function isDecisionAvailable(config: AppConfig): boolean {
  return config.llm.enabled && config.llm.decision.enabled
    && resolveModelRefsForRole(config, "decision").acceptedModelRefs.some(ref => supportsProviderDecision(config.llm.providers[config.llm.models[ref]!.provider]?.type ?? ""));
}

export const nativeCapabilityToolDescriptors: ToolDescriptor[] = [
  {
    modelPolicy: { kind: "bounded_content" },
    definition: {
      type: "function",
      function: {
        name: "generate_speech",
        description: "将中文或其他语言文本生成为可发送的语音资产。仅在用户需要语音时使用，结果为人工智能生成的语音；返回资产句柄后按其发送动作投递。调用会计费，失败后不要盲目重复调用。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 4096, description: "要朗读的原文。" },
            speed: { type: "number", minimum: 0.25, maximum: 4, description: "可选语速，省略使用模型配置。" },
            voice: { type: "string", description: "可选音色，省略使用模型配置。" },
            instructions: { type: "string", maxLength: 4096, description: "可选中文风格说明，例如自然温柔地朗读。" },
            format: { type: "string", enum: ["mp3", "opus", "aac", "flac", "wav"] }
          },
          required: ["text"], additionalProperties: false
        }
      }
    },
    isEnabled: isSpeechGenerationAvailable,
    resultObservation: chatFileListPolicy()
  },
  {
    modelPolicy: { kind: "observe" },
    definition: {
      type: "function",
      function: {
        name: "make_decision",
        description: "对给定证据进行条件判断、固定选项分类或有序等级评分。返回概率或选项，不代替事实核查，不执行任何动作；仅在确实需要专门决策模型时调用。问题及说明使用中文。",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", minLength: 1, description: "用于判断的文本证据与任务说明。" },
            data: { anyOf: [{ type: "object", additionalProperties: true }, { type: "array", items: { type: "object", additionalProperties: true } }], description: "可选结构化 JSON 证据，不超过 256 KiB；其中的路径、URL 只作为数据，不会被读取。" },
            reference_images: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16, description: "可选静态图片资产的 asset_ref 或 file_id。只接受已导入资产，不能传本地路径或网络 URL。" },
            questions: {
              type: "array", minItems: 1, maxItems: 400,
              items: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1, description: "本次请求内唯一的问题名。" },
                  type: { type: "string", enum: ["predicate", "choice", "score"] },
                  instructions: { type: "string", minLength: 1, description: "判断条件或评分标准。" },
                  choices: { type: "array", minItems: 2, maxItems: 255, items: { type: "object", properties: { value: { type: ["string", "boolean"] }, description: { type: "string" } }, required: ["value"], additionalProperties: false } },
                  levels: { type: "array", minItems: 2, maxItems: 10, items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"], additionalProperties: false } }
                },
                required: ["name", "type", "instructions"], additionalProperties: false
              }
            }
          }, required: ["input", "questions"], additionalProperties: false
        }
      }
    },
    isEnabled: isDecisionAvailable,
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  }
];

export const nativeCapabilityToolHandlers: Record<string, ToolHandler> = {
  async generate_speech(_call, args, context) {
    try {
      if (!isSpeechGenerationAvailable(context.config) || !context.nativeCapabilities) throw new Error("语音生成未启用或未配置官方模型");
      const result = await context.nativeCapabilities.synthesize({
        text: getStringArg(args, "text"),
        ...(getNumberArg(args, "speed") !== undefined ? { speed: getNumberArg(args, "speed")! } : {}),
        ...(getStringArg(args, "voice") ? { voice: getStringArg(args, "voice") } : {}),
        ...(getStringArg(args, "instructions") ? { instructions: getStringArg(args, "instructions") } : {}),
        ...(getStringArg(args, "format") ? { format: getStringArg(args, "format") as SpeechFormat } : {}),
        timeoutMsOverride: context.config.llm.speechGeneration.timeoutMs,
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
      });
      context.abortSignal?.throwIfAborted();
      const stored = await context.chatFileStore.importBuffer({
        buffer: result.buffer, sourceName: `generated.${result.extension}`, mimeType: result.mimeType,
        kind: "audio", origin: "audio_generated",
        sourceContext: { tool: "generate_speech", modelRef: result.usage.modelRef, aiGenerated: true }
      });
      const file = buildChatFileHandleResultFromContext(stored, context);
      return JSON.stringify({ ok: true, ai_generated: true, model_ref: result.usage.modelRef, asset_ref: stored.fileRef, file_id: stored.fileId, file, asset_handle: file.asset_handle, next_actions: file.next_actions ?? [] });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async make_decision(_call, args, context) {
    try {
      if (!isDecisionAvailable(context.config) || !context.nativeCapabilities) throw new Error("决策能力未启用或未配置支持的模型");
      const questions = (args as Record<string, unknown>)?.questions as DecisionQuestion[];
      validateDecisionQuestions(questions);
      const input = await buildDecisionToolInput(args, context);
      const result = await context.nativeCapabilities.decide({ input, questions, timeoutMsOverride: context.config.llm.decision.timeoutMs, ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}) });
      return JSON.stringify({ ok: true, answers: result.answers, usage: result.usage });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
};

import { s } from "#data/schema/index.ts";
import { createModelApiParametersSchema, modelApiParametersSchema } from "./modelApiParameterSchema.ts";
import type { LlmProviderType } from "./llmProviderDefinitions.ts";

export const modelOperations = ["chat", "embedding", "image", "transcription"] as const;
export type ModelOperation = typeof modelOperations[number];
const empty = () => ({} as never);
const capability = (label: string) => s.boolean().title(label).describe("留空表示未知；可根据接口清单自动填写。").optional();
const tokenLimit = (label: string) => s.number().int().positive().title(label).optional();
const limits = () => s.object({
  contextTokens: tokenLimit("上下文总上限"), maxInputTokens: tokenLimit("输入上限"), maxOutputTokens: tokenLimit("输出上限")
}).title("模型限制").default(empty);
const capabilities = () => s.object({
  supportsThinking: capability("支持思考"), thinkingControllable: capability("可关闭思考"),
  supportsVision: capability("支持图片输入"), supportsAudioInput: capability("支持音频输入"),
  supportsTools: capability("支持工具"), supportsSearch: capability("支持原生搜索")
}).title("已知能力").default(empty);
const choices = (label: string) => s.array(s.string().nonempty()).title(label).optional();

export function createModelOperationShape(type?: LlmProviderType) {
  const generation = type ? createModelApiParametersSchema(type) : modelApiParametersSchema;
  const chat = () => s.object({
    capabilities: capabilities(), limits: limits(),
    defaults: generation,
    preserveThinking: s.boolean().title("保留历史思考").default(false),
    searchEnabled: s.boolean().title("启用原生搜索").default(false)
  });
  return {
    displayName: s.string().trim().nonempty().title("显示名称").optional(),
    chat: chat().title("聊天").optional(),
    embedding: s.object({
      limits: s.object({ maxInputTokens: tokenLimit("输入上限") }).title("模型限制").default(empty),
      dimensions: s.number().int().positive().title("请求向量维度").describe("留空使用上游默认；服务必须支持此参数。").optional(),
      inputMode: s.enum(["plain", "qwen3", "input_type"] as const).title("输入处理").describe("plain 原文；qwen3 查询任务指令；input_type 发送查询/文档类型。").default("plain"),
      queryInstruction: s.string().trim().nonempty().title("查询任务说明").default("根据查询检索相关的资料和记忆。")
    }).title("向量").optional(),
    image: s.object({
      capabilities: s.object({ referenceImages: capability("支持参考图（当前工具尚不提供编辑）"), streaming: capability("支持流式（当前工具使用非流式）") }).title("已知能力").default(empty),
      constraints: s.object({ sizes: choices("尺寸选项"), aspectRatios: choices("比例选项"), resolutions: choices("分辨率选项"), qualities: choices("质量选项") }).title("参数范围").default(empty),
      defaults: s.object({
        size: s.string().trim().nonempty().title("尺寸").optional(),
        aspect_ratio: s.string().trim().nonempty().title("比例（OpenRouter）").optional(),
        resolution: s.string().trim().nonempty().title("分辨率（OpenRouter）").optional(),
        quality: s.string().trim().nonempty().title("质量").optional(),
        output_format: s.enum(["png", "jpeg", "webp"] as const).title("输出格式").optional(),
        response_format: s.enum(["b64_json", "url"] as const).title("响应格式（Images 兼容接口）").optional(),
        seed: s.number().int().title("种子（OpenRouter）").optional()
      }).title("默认参数").default(empty)
    }).title("图像生成").optional(),
    transcription: chat().title("音频转写").describe("通过本服务的聊天音频协议调用；不是 /audio/transcriptions 接口。").optional()
  };
}

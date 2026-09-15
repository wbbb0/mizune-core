import { s, type Infer } from "#data/schema/index.ts";
import type { LlmProviderType } from "./llmProviderDefinitions.ts";

function parameterFields() {
  return {
    temperature: s.number().min(0).title("随机程度（temperature）").describe("越低越稳定；是否支持及上限取决于模型。留空使用上游默认值。").optional(),
    top_p: s.number().min(0).max(1).title("累计概率阈值（top_p）").optional(),
    top_k: s.number().int().min(0).title("候选词数量（top_k）").optional(),
    min_p: s.number().min(0).max(1).title("最低相对概率（min_p）").optional(),
    presence_penalty: s.number().title("内容重复惩罚（presence_penalty）").optional(),
    repetition_penalty: s.number().positive().title("词元重复惩罚（repetition_penalty）").optional(),
    maxOutputTokens: s.number().int().positive().title("最大输出 Token").describe("自动转换为供应商参数；部分模型的思考也计入该上限。留空沿用接口默认值。").optional(),
    extra: s.object({}).passthrough().title("额外请求参数（高级）").describe("少见参数按协议目标位置透传。常用字段请优先使用上方控件；显式字段优先于同名额外参数。").optional()
  };
}

export const modelApiParametersSchema = s.object(parameterFields()).title("生成参数").default(() => ({} as never));
export type ModelApiParameters = Infer<typeof modelApiParametersSchema>;
type SamplingKey = Exclude<keyof ModelApiParameters, "extra" | "maxOutputTokens">;
const samplingKeys: Record<LlmProviderType, readonly SamplingKey[]> = {
  openai: ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repetition_penalty"],
  openai_responses: ["temperature", "top_p"],
  deepseek: ["temperature", "top_p"],
  anthropic: ["temperature", "top_p", "top_k"],
  google: ["temperature", "top_p", "top_k", "presence_penalty"],
  vertex: ["temperature", "top_p", "top_k", "presence_penalty"],
  vertex_express: ["temperature", "top_p", "top_k", "presence_penalty"],
  dashscope: ["temperature", "top_p", "top_k", "presence_penalty", "repetition_penalty"],
  lmstudio: ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repetition_penalty"]
};

export function createModelApiParametersSchema(type: LlmProviderType) {
  const fields = parameterFields();
  const sampling = Object.fromEntries(samplingKeys[type].map(key => [key, fields[key]])) as Partial<Pick<typeof fields, SamplingKey>>;
  return s.object({ ...sampling, maxOutputTokens: fields.maxOutputTokens, extra: fields.extra })
    .title("生成参数").describe("仅列出此协议的常用参数；具体模型不支持的参数请留空。").default(() => ({} as never));
}

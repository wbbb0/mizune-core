import { s, type Infer } from "#data/schema/index.ts";

export const DEFAULT_CONTENT_SAFETY_PROVIDER = "aliyun";

const emptyObject = () => ({} as never);
const remoteSettingsShape = {
  timeoutMs: s.number().int().positive().title("超时毫秒").default(6000),
  proxy: s.boolean().title("使用代理").default(false)
};

export const aliyunContentSafetySettingsSchema = s.object({
  ...remoteSettingsShape,
  endpoint: s.string().trim().nonempty().title("Endpoint").optional(),
  regionId: s.string().trim().nonempty().title("地域").optional(),
  accessKeyId: s.string().trim().nonempty().title("AccessKeyId").optional(),
  accessKeySecret: s.string().trim().nonempty().title("AccessKeySecret").optional(),
  accessKeyIdEnv: s.string().trim().nonempty().title("AccessKeyId 环境变量").optional(),
  accessKeySecretEnv: s.string().trim().nonempty().title("AccessKeySecret 环境变量").optional(),
  services: s.object({
    text: s.string().trim().nonempty().title("文本审核服务").optional(),
    image: s.string().trim().nonempty().title("图片审核服务").optional()
  }).title("服务").default(emptyObject),
  variants: s.object({
    text: s.enum(["text", "text_plus"] as const).title("文本接口").default("text_plus"),
    image: s.enum(["image"] as const).title("图片接口").default("image")
  }).title("接口变体").default(emptyObject)
}).title("阿里云配置").default(emptyObject);

export const openAiContentSafetySettingsSchema = s.object({
  ...remoteSettingsShape,
  baseUrl: s.string().trim().url().title("接口地址").describe("填写 API 根地址，例如 https://api.openai.com/v1。").default("https://api.openai.com/v1"),
  apiKey: s.string().trim().nonempty().title("API Key").optional(),
  apiKeyEnv: s.string().trim().nonempty().title("API Key 环境变量").default("OPENAI_API_KEY"),
  model: s.string().trim().nonempty().title("审核模型").default("omni-moderation-latest")
}).title("OpenAI 配置").default(emptyObject);

const keywordContentSafetySettingsSchema = s.object({
  blockedTextKeywords: s.array(s.string().trim().nonempty()).title("文本阻断关键词").default([]),
  blockedMediaNameKeywords: s.array(s.string().trim().nonempty()).title("媒体文件名阻断关键词").default([])
}).title("关键词配置").default(emptyObject);

export type AliyunContentSafetyProviderConfig = Infer<typeof aliyunContentSafetySettingsSchema>;
export type OpenAiContentSafetyProviderConfig = Infer<typeof openAiContentSafetySettingsSchema>;
export type KeywordContentSafetyProviderConfig = Infer<typeof keywordContentSafetySettingsSchema>;

export const contentSafetyRuleConfigSchema = s.object({
  action: s.enum([
    "allow",
    "mark",
    "replace_in_projection",
    "hide_from_projection_and_mark",
    "mark_unavailable",
    "block_message"
  ] as const).title("动作").default("replace_in_projection"),
  blockRiskLevels: s.array(s.enum(["high", "medium", "low", "none"] as const)).title("阻断风险等级").default(["high"]),
  reviewRiskLevels: s.array(s.enum(["high", "medium", "low", "none"] as const)).title("复核风险等级").default(["medium"]),
  blockConfidenceGte: s.number().min(0).max(100).title("阻断置信度阈值").optional()
}).title("内容安全规则").default(emptyObject);

const contentSafetyProfileConfigSchema = s.object({
  text: s.field(contentSafetyRuleConfigSchema, { title: "文本规则" }),
  image: s.field(contentSafetyRuleConfigSchema, { title: "图片规则" }),
  emoji: s.field(contentSafetyRuleConfigSchema, { title: "表情规则" }),
  audio: s.field(contentSafetyRuleConfigSchema, { title: "音频规则" })
}).title("内容安全 Profile").default(emptyObject);

const commonSafetyShape = {
  enabled: s.boolean().title("启用").default(false),
  failPolicy: s.enum(["allow", "mark"] as const).title("失败策略").default("allow"),
  audit: s.object({
    preserveOriginalText: s.boolean().title("保留原始文本").default(true),
    preserveOriginalFiles: s.boolean().title("保留原始文件").default(true),
    exposeOriginalInAdminApi: s.boolean().title("后台 API 暴露原始内容").default(true),
    maxOriginalTextChars: s.number().int().positive().title("原始文本最大字符数").default(20000)
  }).title("审计").default(emptyObject),
  cache: s.object({
    enabled: s.boolean().title("启用缓存").default(true),
    ttlMs: s.number().int().positive().title("缓存 TTL 毫秒").default(30 * 24 * 60 * 60 * 1000),
    version: s.number().int().min(0).title("缓存版本").default(1),
    storeAllowResults: s.boolean().title("缓存放行结果").default(true)
  }).title("缓存").default(emptyObject),
  textBatch: s.object({
    enabled: s.boolean().title("启用文本批量审核").default(true),
    maxMessages: s.number().int().positive().title("单批最大消息数").default(10),
    maxChars: s.number().int().positive().title("单批最大字符数").default(4000),
    singleMessageMaxChars: s.number().int().positive().title("单条独立审核字符数").default(1200),
    maxLocateConcurrency: s.number().int().positive().title("命中定位最大并发").default(5)
  }).title("文本批量审核").default(emptyObject),
  marker: s.object({
    includeProvider: s.boolean().title("包含 Provider").default(true),
    includeLabels: s.boolean().title("包含标签").default(true),
    includeConfidence: s.boolean().title("包含置信度").default(false),
    includeSubjectRef: s.boolean().title("包含对象引用").default(true)
  }).title("屏蔽标记").default(emptyObject),
  profiles: s.record(
    s.string().trim().nonempty(),
    contentSafetyProfileConfigSchema
  ).title("Profile 列表").default({}),
  routes: s.object({
    prompt: s.object({
      preLlm: s.string().trim().nonempty().title("LLM 调用前 Profile").optional()
    }).title("Prompt 调用前").default(emptyObject),
    toolMedia: s.object({
      chatFile: s.string().trim().nonempty().title("聊天文件 Profile").optional(),
      localFile: s.string().trim().nonempty().title("本地文件 Profile").optional()
    }).title("工具媒体").default(emptyObject),
    llmProviderFallback: s.object({
      dashscope: s.object({
        useDataInspectionHeader: s.boolean().title("使用 DashScope 内容安全请求头").default(false)
      }).title("DashScope").default(emptyObject)
    }).title("LLM Provider 兜底").default(emptyObject)
  }).title("路由").default(emptyObject)
};


export const contentSafetyConfigSchema = s.discriminatedUnion("provider", [
  s.object({
    provider: s.literal("aliyun").title("供应商").default("aliyun"),
    ...commonSafetyShape,
    config: aliyunContentSafetySettingsSchema
  }).title("阿里云内容安全"),
  s.object({
    provider: s.literal("openai").title("供应商").default("openai"),
    ...commonSafetyShape,
    config: openAiContentSafetySettingsSchema
  }).title("OpenAI 内容安全"),
  s.object({
    provider: s.literal("keyword").title("供应商").default("keyword"),
    ...commonSafetyShape,
    config: keywordContentSafetySettingsSchema
  }).title("本地关键词（调试）"),
  s.object({
    provider: s.literal("noop").title("供应商").default("noop"),
    ...commonSafetyShape,
    config: s.object({}).title("无需配置").default(emptyObject)
  }).title("直接放行（调试）")
] as const).title("内容安全").describe("统一选择审核供应商，所有规则均使用该供应商；默认关闭。").default(() => ({ provider: DEFAULT_CONTENT_SAFETY_PROVIDER }) as never);

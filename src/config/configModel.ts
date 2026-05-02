import { createSchemaTemplate, parseConfig, s, type Infer } from "#data/schema/index.ts";

const emptyObject = () => ({} as never);
const modelProfileSchema = s.object({
  provider: s.string().trim().nonempty().dynamicRef("llm_provider_names").title("Provider"),
  model: s.string().trim().nonempty().title("模型名"),
  modelType: s.enum(["chat", "transcription", "image_generation"] as const).title("模型类型").default("chat"),
  supportsThinking: s.boolean().title("支持思考").default(false),
  thinkingControllable: s.boolean().title("可控制思考").default(true),
  supportsVision: s.boolean().title("支持视觉").default(false),
  supportsAudioInput: s.boolean().title("支持音频输入").default(false),
  supportsSearch: s.boolean().title("支持搜索").default(false),
  supportsTools: s.boolean().title("支持工具").default(true),
  preserveThinking: s.boolean().title("保留历史思考").default(false)
}).title("模型配置").describe("定义一个模型别名对应的 provider 能力与特性。").default(emptyObject);

const createModelRefListSchema = () => s.oneOrMany(s.string().trim().nonempty().dynamicRef("llm_model_names")).optional();

const llmRoutingPresetSchema = s.object({
  mainSmall: createModelRefListSchema().title("主路由轻量模型"),
  mainLarge: createModelRefListSchema().title("主路由完整模型"),
  summarizer: createModelRefListSchema().title("总结器"),
  sessionCaptioner: createModelRefListSchema().title("会话标题生成"),
  imageCaptioner: createModelRefListSchema().title("图片描述"),
  imageInspector: createModelRefListSchema().title("图片精读"),
  audioTranscription: createModelRefListSchema().title("音频转写"),
  turnPlanner: createModelRefListSchema().title("轮次规划")
}).title("模型路由预设").describe("为各个模型角色提供统一的模型引用列表。");

const onebotTypingConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  private: s.boolean().title("私聊").default(true),
  group: s.boolean().title("群聊").default(false)
}).title("输入状态").describe("控制 OneBot 输入中提示的发送范围。").default(emptyObject);

const onebotHistoryBackfillConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  maxMessagesPerSession: s.number().int().positive().title("单会话消息上限").default(20),
  maxTotalMessages: s.number().int().positive().title("总消息上限").default(100),
  requestDelayMs: s.number().int().min(0).title("请求间隔毫秒").default(100)
}).title("历史补全").describe("启动时从支持历史扩展接口的 OneBot 实现拉取已有会话的缺失消息，只写入历史，不触发回复。").default(emptyObject);

const onebotConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  provider: s.enum(["generic", "napcat"] as const).title("实现").default("generic"),
  wsUrl: s.string().url().title("WS 地址").default("ws://127.0.0.1:3001"),
  httpUrl: s.string().url().title("HTTP 地址").default("http://127.0.0.1:3000"),
  accessToken: s.string().trim().nonempty().title("访问令牌").optional(),
  typing: onebotTypingConfigSchema,
  historyBackfill: onebotHistoryBackfillConfigSchema
}).title("OneBot").describe("配置 OneBot 连接方式与消息发送行为。").default(emptyObject);

const proxyDetailSchema = s.object({
  type: s.enum(["http", "https", "socks5"] as const).title("类型"),
  host: s.string().trim().nonempty().title("主机"),
  port: s.number().int().positive().title("端口"),
  username: s.string().trim().nonempty().title("用户名").optional(),
  password: s.string().trim().nonempty().title("密码").optional()
}).title("代理");

const proxyConfigSchema = s.object({
  http: proxyDetailSchema.optional(),
  https: proxyDetailSchema.optional()
}).title("代理").describe("为支持代理的外部请求配置 HTTP 或 HTTPS 代理。").default(emptyObject);

const llmTurnPlannerConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(20000),
  enableThinking: s.boolean().title("启用思考").default(false),
  recentMessageCount: s.number().int().positive().title("近期消息数").default(6),
  maxWaitPasses: s.number().int().min(0).title("最大等待轮数").default(1),
  supplementToolsets: s.boolean().title("补充工具集").default(true)
}).title("轮次规划").describe("决定是否继续等待新消息，还是开始本轮回复。").default(emptyObject);

const llmImageCaptionerConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(30000),
  enableThinking: s.boolean().title("启用思考").default(false),
  maxConcurrency: s.number().int().positive().title("最大并发").default(2)
}).title("图片描述").describe("为图片生成补充描述，供会话上下文使用。").default(emptyObject);

const llmImageInspectorConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(45000),
  enableThinking: s.boolean().title("启用思考").default(false),
  maxConcurrency: s.number().int().positive().title("最大并发").default(2)
}).title("图片精读").describe("按问题读取图片里的具体可见信息。").default(emptyObject);

const llmAudioTranscriptionConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(30000),
  enableThinking: s.boolean().title("启用思考").default(false),
  maxConcurrency: s.number().int().positive().title("最大并发").default(2)
}).title("音频转写").describe("控制语音消息的转写模型与并发。").default(emptyObject);

const llmDebugDumpSchema = s.object({
  enabled: s.boolean().title("启用").default(false)
}).title("调试导出").default(emptyObject);

const llmMainRoutingConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(300000),
  enableThinking: s.boolean().title("启用思考").default(true)
}).title("主路由").describe("在主回复链路中选择不同规模的模型。").default(emptyObject);

const llmProviderFeatureFlagSchema = s.object({
  type: s.literal("flag"),
  path: s.string().trim().nonempty()
}).strict();

const llmProviderFeatureBuiltinToolSchema = s.object({
  type: s.literal("builtin_tool"),
  tool: s.object({}).passthrough()
}).strict();

const createLlmProviderFeatureSchema = () => s.union([
  llmProviderFeatureFlagSchema,
  llmProviderFeatureBuiltinToolSchema
]);

const llmProviderFeaturesSchema = s.object({
  thinking: createLlmProviderFeatureSchema().title("思考").optional(),
  search: createLlmProviderFeatureSchema().title("搜索").optional()
}).title("能力映射").default(emptyObject);

const llmProviderSchema = s.object({
  type: s.enum(["openai", "deepseek", "google", "vertex", "vertex_express", "dashscope", "lmstudio"] as const).title("类型").default("openai"),
  baseUrl: s.string().url().nonempty().title("Base URL").optional(),
  apiKey: s.string().trim().nonempty().title("API Key").optional(),
  proxy: s.boolean().title("使用代理").default(false),
  harmBlockThreshold: s.enum([
    "BLOCK_NONE",
    "BLOCK_ONLY_HIGH",
    "BLOCK_MEDIUM_AND_ABOVE",
    "BLOCK_LOW_AND_ABOVE",
    "HARM_BLOCK_THRESHOLD_UNSPECIFIED"
  ] as const).title("内容拦截阈值").default("BLOCK_NONE"),
  features: llmProviderFeaturesSchema
}).title("Provider 配置").describe("定义一个 LLM provider 的连接信息与能力开关。").default(emptyObject);

const conversationConfigSchema = s.object({
  setup: s.object({
    skipPersonaInitialization: s.boolean().title("跳过 Persona 初始化").default(false)
  }).title("初始化").describe("控制是否跳过全局 persona 初始化门槛；用于联调时快速进入其他功能。").default(emptyObject),
  historyWindow: s.object({
    maxRecentMessages: s.number().int().positive().title("最大近期消息数").default(50),
    maxImageReferences: s.number().int().positive().title("最大图片引用数").default(5)
  }).title("历史窗口").describe("控制参与本轮生成的近期消息与图片引用范围。").default(emptyObject),
  images: s.object({
    maxSerializedPixels: s.number().int().positive().title("最大序列化像素").default(1024 ** 2),
    maxCachedFiles: s.number().int().positive().title("最大缓存文件数").default(100)
  }).title("图片").default(emptyObject),
  debounce: s.object({
    defaultBaseSeconds: s.number().positive().title("默认基础秒数").default(6),
    minBaseSeconds: s.number().positive().title("最小基础秒数").default(5),
    maxBaseSeconds: s.number().positive().title("最大基础秒数").default(20),
    smoothingFactor: s.number().min(0).max(1).title("平滑系数").default(0.3),
    finalMultiplier: s.number().positive().title("收尾倍率").default(1.5),
    plannerWaitMultiplier: s.number().positive().title("规划等待倍率").default(2),
    randomRatioMin: s.number().min(0.5).max(1).title("随机下限").default(0.8),
    randomRatioMax: s.number().min(1).max(2).title("随机上限").default(1.25)
  }).title("防抖").default(emptyObject),
  outbound: s.object({
    disableStreamingSplit: s.boolean().title("不启用分割").default(false),
    baseDelayMs: s.number().int().min(0).title("基础延迟毫秒").default(1200),
    charDelayMs: s.number().int().min(0).title("每字延迟毫秒").default(200),
    maxDelayMs: s.number().int().min(0).title("最大延迟毫秒").default(20000),
    randomFactorMin: s.number().min(0).max(2).title("随机倍率下限").default(0.8),
    randomFactorMax: s.number().min(0).max(2).title("随机倍率上限").default(1.25)
  }).title("发送").describe("控制回复分段与需要拟人化节奏的投递目标延迟。").default(emptyObject),
  historyCompression: s.object({
    enabled: s.boolean().title("启用").default(true),
    triggerTokens: s.number().int().positive().title("触发 Token").default(150000),
    retainTokens: s.number().int().positive().title("保留 Token").default(4000),
    retainMessageCount: s.number().int().min(0).title("保留消息数").default(8),
    tokenEstimation: s.object({
      cjkTokens: s.number().positive().title("CJK Token 系数").default(2),
      nonAsciiTokens: s.number().positive().title("非 ASCII Token 系数").default(1),
      asciiTokens: s.number().positive().title("ASCII Token 系数").default(0.25)
    }).title("Token 估算").default(emptyObject)
  }).title("历史压缩").describe("控制会话历史在过长时如何压缩。").default(emptyObject),
  group: s.object({
    requireAtMention: s.boolean().title("需要 @").default(true),
    ambientRecallMessageCount: s.number().int().min(0).title("环境消息召回数").default(8)
  }).title("群聊").default(emptyObject)
}).title("会话").describe("控制会话上下文、压缩和消息发送节奏。").default(emptyObject);

const internalApiWebuiConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  auth: s.object({
    enabled: s.boolean().title("启用").default(true)
  }).title("认证").default(emptyObject),
  port: s.number().int().positive().title("端口").default(3031),
  allowedHosts: s.array(s.string().trim().nonempty()).title("允许主机").default([])
}).title("WebUI").describe("配置内置 WebUI 的监听与访问限制。").default(emptyObject);

const internalApiConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  port: s.number().int().positive().title("端口").default(3030),
  webui: internalApiWebuiConfigSchema
}).title("内部 API").describe("配置内部管理 API 与 WebUI 服务。").default(emptyObject);

const schedulerConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  defaultTimezone: s.string().trim().nonempty().title("默认时区").default("Asia/Shanghai")
}).title("定时任务").describe("控制计划任务系统与默认时区。").default(emptyObject);

const shellTerminalEventsConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  inputDetectionDebounceMs: s.number().int().min(0).title("输入检测防抖毫秒").default(800),
  inputConfirmationMs: s.number().int().min(0).title("输入检测确认毫秒").default(1200),
  inputPromptCooldownMs: s.number().int().min(0).title("同一输入提示冷却毫秒").default(30000),
  inputSuppressionAfterWriteMs: s.number().int().min(0).title("写入后抑制检测毫秒").default(1200),
  detectionTailMaxChars: s.number().int().positive().title("输入检测最大尾部字符数").default(8000)
}).title("Terminal 事件").describe("控制后台 terminal 完成和等待输入事件。").default(emptyObject);

const shellConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  defaultTimeoutMs: s.number().int().positive().title("默认超时毫秒").default(15000),
  maxTimeoutMs: s.number().int().positive().title("最大超时毫秒").default(600000),
  maxOutputChars: s.number().int().positive().title("最大输出字符数").default(12000),
  sessionTtlMs: s.union([s.number().int().positive(), s.literal(null)]).title("会话存活毫秒").default(null),
  terminalEvents: shellTerminalEventsConfigSchema
}).title("Shell").describe("控制 shell 工具的超时、输出与会话保活。").default(emptyObject);

const localFilesConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  root: s.string().trim().nonempty().title("根目录").default("data"),
  maxPatchFileBytes: s.number().int().positive().title("最大补丁文件字节数").default(512 * 1024)
}).title("本地文件").describe("控制工作区本地文件读写能力。").default(emptyObject);

const chatFilesConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(true),
  root: s.string().trim().nonempty().title("根目录").default("chat-files"),
  maxUploadBytes: s.number().int().positive().title("最大上传字节数").default(32 * 1024 * 1024),
  gcGracePeriodMs: s.number().int().min(0).title("回收宽限毫秒").default(7 * 24 * 60 * 60 * 1000)
}).title("聊天文件").describe("管理聊天上传文件的存储与清理。").default(emptyObject);

const comfyTemplateParameterBindingsSchema = s.object({
  positivePromptPath: s.string().trim().nonempty().title("正向提示词路径"),
  widthPath: s.string().trim().nonempty().title("宽度路径"),
  heightPath: s.string().trim().nonempty().title("高度路径")
}).title("参数绑定").strict();

const comfyTemplateResultPolicySchema = s.object({
  maxAutoIterations: s.number().int().min(0).title("最大自动迭代次数").default(1),
  defaultActionHint: s.enum(["decide_by_model"] as const).title("默认动作提示").default("decide_by_model")
}).title("结果策略").default(emptyObject);

const comfyTemplateConfigSchema = s.object({
  id: s.string().trim().nonempty().title("ID"),
  label: s.string().trim().nonempty().title("名称"),
  workflowFile: s.string().trim().nonempty().title("工作流文件"),
  enabled: s.boolean().title("启用").default(true),
  description: s.string().trim().nonempty().title("说明").optional(),
  parameterBindings: comfyTemplateParameterBindingsSchema,
  resultPolicy: comfyTemplateResultPolicySchema
}).title("模板").describe("定义一个 ComfyUI 模板在编辑器中的展示与参数绑定。").strict();

const comfyAspectRatioSchema = s.object({
  width: s.number().int().positive().title("宽度"),
  height: s.number().int().positive().title("高度")
}).title("宽高比").strict();

const comfyConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  apiBaseUrl: s.string().url().title("API 地址").default("http://192.168.0.223:8188"),
  templateRoot: s.string().trim().nonempty().title("模板目录").default("templates/comfyui"),
  submitTimeoutMs: s.number().int().positive().title("提交超时毫秒").default(15000),
  pollIntervalMs: s.number().int().positive().title("轮询间隔毫秒").default(3000),
  maxConcurrentTasks: s.number().int().positive().title("最大并发任务数").default(2),
  aspectRatios: s.record(
    s.string().trim().nonempty(),
    comfyAspectRatioSchema
  ).title("宽高比").default({
    "1:1": {
      width: 1024,
      height: 1024
    }
  }),
  templates: s.array(comfyTemplateConfigSchema).title("模板列表").default([])
}).title("ComfyUI").describe("配置 ComfyUI 服务、模板目录与默认模板清单。").default(emptyObject);

const googleGroundingSearchSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  proxy: s.boolean().title("使用代理").default(false),
  apiKey: s.string().trim().nonempty().title("API Key").optional(),
  model: s.string().trim().nonempty().title("模型").default("gemini-2.5-flash"),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(30000),
  maxSources: s.number().int().positive().title("最大来源数").default(8),
  resolveRedirectUrls: s.boolean().title("解析跳转链接").default(true)
}).title("Google Grounding").default(emptyObject);

const aliyunIqsSearchSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  proxy: s.boolean().title("使用代理").default(false),
  apiKey: s.string().trim().nonempty().title("API Key").optional(),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(30000),
  defaultNumResults: s.number().int().min(1).max(50).title("默认结果数").default(8),
  maxNumResults: s.number().int().min(1).max(50).title("最大结果数").default(20),
  defaultIncludeMainText: s.boolean().title("默认包含正文").default(false),
  defaultIncludeMarkdownText: s.boolean().title("默认包含 Markdown").default(false)
}).title("阿里云 IQS").default(emptyObject);

const searchConfigSchema = s.object({
  googleGrounding: googleGroundingSearchSchema,
  aliyunIqs: aliyunIqsSearchSchema
}).title("搜索").describe("配置联网搜索能力及各搜索提供方。").default(emptyObject);

const playwrightSearchSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  proxy: s.boolean().title("使用代理").default(false),
  headless: s.boolean().title("无头模式").default(true),
  actionTimeoutMs: s.number().int().positive().title("动作超时毫秒").default(15000),
  navigationTimeoutMs: s.number().int().positive().title("导航超时毫秒").default(30000),
  maxSnapshotChars: s.number().int().positive().title("最大快照字符数").default(20000),
  persistSessionState: s.boolean().title("持久化会话状态").default(true),
  persistSessionStorage: s.boolean().title("持久化 Session Storage").default(true),
  profileAutoSaveDebounceMs: s.number().int().min(0).title("配置自动保存防抖毫秒").default(250),
  profileMaxCount: s.number().int().positive().title("最大配置数").default(24),
  screenshotMaxBytes: s.number().int().positive().title("截图最大字节数").default(5 * 1024 * 1024)
}).title("Playwright").default(emptyObject);

const browserConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  browseMaxContentChars: s.number().int().positive().title("浏览最大内容字符数").default(16000),
  sessionTtlMs: s.number().int().positive().title("会话存活毫秒").default(3600000),
  playwright: playwrightSearchSchema
}).title("浏览器").describe("配置网页浏览能力与 Playwright 浏览器会话。").default(emptyObject);

const backupConfigSchema = s.object({
  profileRotateLimit: s.number().int().positive().title("配置轮换保留数").default(10)
}).title("备份").describe("控制浏览器等配置文件的备份保留策略。").default(emptyObject);

const contentSafetyProviderConfigSchema = s.object({
  type: s.enum(["noop", "keyword", "aliyun_content_moderation", "dashscope_data_inspection"] as const).title("类型").default("noop"),
  enabled: s.boolean().title("启用").default(true),
  endpoint: s.string().trim().nonempty().title("Endpoint").optional(),
  regionId: s.string().trim().nonempty().title("地域").optional(),
  accessKeyId: s.string().trim().nonempty().title("AccessKeyId").optional(),
  accessKeySecret: s.string().trim().nonempty().title("AccessKeySecret").optional(),
  accessKeyIdEnv: s.string().trim().nonempty().title("AccessKeyId 环境变量").optional(),
  accessKeySecretEnv: s.string().trim().nonempty().title("AccessKeySecret 环境变量").optional(),
  apiKey: s.string().trim().nonempty().title("API Key").optional(),
  apiKeyEnv: s.string().trim().nonempty().title("API Key 环境变量").optional(),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(6000),
  proxy: s.boolean().title("使用代理").default(false),
  services: s.object({
    text: s.string().trim().nonempty().title("文本审核服务").optional(),
    image: s.string().trim().nonempty().title("图片审核服务").optional()
  }).title("服务").default(emptyObject),
  variants: s.object({
    text: s.enum(["text", "text_plus"] as const).title("文本接口").default("text_plus"),
    image: s.enum(["image"] as const).title("图片接口").default("image")
  }).title("接口变体").default(emptyObject),
  blockedTextKeywords: s.array(s.string().trim().nonempty()).title("文本阻断关键词").default([]),
  blockedMediaNameKeywords: s.array(s.string().trim().nonempty()).title("媒体文件名阻断关键词").default([])
}).title("内容安全 Provider").default(emptyObject);

const contentSafetyRuleConfigSchema = s.object({
  provider: s.string().trim().nonempty().title("Provider").optional(),
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
  text: contentSafetyRuleConfigSchema,
  image: contentSafetyRuleConfigSchema,
  emoji: contentSafetyRuleConfigSchema,
  audio: contentSafetyRuleConfigSchema,
  unsupportedFilePolicy: s.enum(["allow", "mark", "block"] as const).title("不支持文件策略").default("mark")
}).title("内容安全 Profile").default(emptyObject);

const contentSafetyConfigSchema = s.object({
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
    ttlMs: s.number().int().positive().title("缓存 TTL 毫秒").default(30 * 24 * 60 * 60 * 1000)
  }).title("缓存").default(emptyObject),
  marker: s.object({
    includeProvider: s.boolean().title("包含 Provider").default(true),
    includeLabels: s.boolean().title("包含标签").default(true),
    includeConfidence: s.boolean().title("包含置信度").default(false),
    includeSubjectRef: s.boolean().title("包含对象引用").default(true)
  }).title("屏蔽标记").default(emptyObject),
  providers: s.record(
    s.string().trim().nonempty(),
    contentSafetyProviderConfigSchema
  ).title("Provider 列表").default({}),
  profiles: s.record(
    s.string().trim().nonempty(),
    contentSafetyProfileConfigSchema
  ).title("Profile 列表").default({}),
  routes: s.object({
    inbound: s.object({
      onebot: s.string().trim().nonempty().title("OneBot 入站 Profile").optional(),
      web: s.string().trim().nonempty().title("Web 入站 Profile").optional()
    }).title("入站").default(emptyObject),
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
}).title("内容安全").describe("在内容进入 LLM 前进行可选审核；默认关闭，失败时默认放行并记录警告。").default(emptyObject);

const llmRuntimeConfigSchema = s.object({
  enabled: s.boolean().title("启用").default(false),
  routingPreset: s.string().trim().dynamicRef("llm_routing_preset_names").title("模型路由预设").default(""),
  timeoutMs: s.number().int().positive().title("超时毫秒").default(300000),
  firstTokenTimeoutMs: s.number().int().positive().title("首 Token 超时毫秒").default(30000),
  toolCallMaxIterations: s.number().int().positive().title("工具调用最大轮次").default(8),
  mainRouting: llmMainRoutingConfigSchema,
  summarizer: s.object({
    enabled: s.boolean().title("启用").default(true),
    timeoutMs: s.number().int().positive().title("超时毫秒").default(45000),
    enableThinking: s.boolean().title("启用思考").default(false)
  }).title("总结器").describe("用于历史压缩和内容总结。").default(emptyObject),
  sessionCaptioner: s.object({
    enabled: s.boolean().title("启用").default(true),
    timeoutMs: s.number().int().positive().title("超时毫秒").default(15000),
    enableThinking: s.boolean().title("启用思考").default(false)
  }).title("会话标题生成").describe("为会话生成简短标题。").default(emptyObject),
  imageCaptioner: llmImageCaptionerConfigSchema,
  imageInspector: llmImageInspectorConfigSchema,
  audioTranscription: llmAudioTranscriptionConfigSchema,
  turnPlanner: llmTurnPlannerConfigSchema,
  debugDump: llmDebugDumpSchema
}).title("LLM").describe("配置主模型调用链路与各类辅助模型。").default(emptyObject);

export const llmProviderCatalogSchema = s.record(
  s.string().trim().nonempty(),
  llmProviderSchema
).title("Provider 目录").describe("维护可引用的 provider 别名列表。").default({});

export const llmModelCatalogSchema = s.record(
  s.string().trim().nonempty(),
  modelProfileSchema
).title("模型目录").describe("维护可引用的模型别名列表。").default({});

export const llmRoutingPresetCatalogSchema = s.record(
  s.string().trim().nonempty(),
  llmRoutingPresetSchema
).title("模型路由预设目录").describe("维护可引用的模型路由预设。").default({});

export const llmCatalogSchema = s.object({
  providers: llmProviderCatalogSchema,
  models: llmModelCatalogSchema,
  routingPresets: llmRoutingPresetCatalogSchema
}).title("LLM 目录").default(emptyObject);

export const fileConfigSchema = s.object({
  appName: s.string().trim().nonempty().title("应用名称").default("llm-bot"),
  nodeEnv: s.string().trim().nonempty().title("运行环境").default("development"),
  logLevel: s.string().trim().nonempty().title("日志级别").default("info"),
  dataDir: s.string().trim().nonempty().title("数据目录").default("data"),
  proxy: proxyConfigSchema,
  onebot: onebotConfigSchema,
  llm: llmRuntimeConfigSchema,
  conversation: conversationConfigSchema,
  whitelist: s.object({
    enabled: s.boolean().title("启用").default(true)
  }).title("白名单").describe("控制白名单功能是否生效。").default(emptyObject),
  internalApi: internalApiConfigSchema,
  scheduler: schedulerConfigSchema,
  shell: shellConfigSchema,
  localFiles: localFilesConfigSchema,
  chatFiles: chatFilesConfigSchema,
  comfy: comfyConfigSchema,
  contentSafety: contentSafetyConfigSchema,
  search: searchConfigSchema,
  browser: browserConfigSchema,
  backup: backupConfigSchema
}).title("运行时配置");

export const configRuntimeSchema = s.object({
  configDir: s.string().trim().nonempty(),
  globalExampleConfigPath: s.string().trim().nonempty(),
  globalConfigPath: s.string().trim().nonempty(),
  llmProviderCatalogPath: s.string().trim().nonempty(),
  llmModelCatalogPath: s.string().trim().nonempty(),
  llmRoutingPresetCatalogPath: s.string().trim().nonempty(),
  instanceName: s.string().trim().nonempty(),
  instanceConfigPath: s.string().trim().nonempty(),
  loadedConfigPaths: s.array(s.string().trim().nonempty()).default([])
});

export function createEmptyFileConfig(): FileConfig {
  return parseConfig(fileConfigSchema, createSchemaTemplate(fileConfigSchema));
}

export function createEmptyLlmCatalogConfig(): LlmCatalogConfig {
  return parseConfig(llmCatalogSchema, createSchemaTemplate(llmCatalogSchema));
}

export type FileConfig = Infer<typeof fileConfigSchema>;
export type LlmRuntimeConfig = Infer<typeof llmRuntimeConfigSchema>;
export type LlmCatalogConfig = Infer<typeof llmCatalogSchema>;
export type ConfigRuntime = Infer<typeof configRuntimeSchema>;
export type ModelProfile = Infer<typeof modelProfileSchema>;
export type LlmRoutingPreset = Infer<typeof llmRoutingPresetSchema>;
export type ProxyConfig = Infer<typeof proxyConfigSchema>;
export type LlmProviderConfig = Infer<typeof llmProviderSchema>;
export type OnebotConfig = Infer<typeof onebotConfigSchema>;
export type ConversationConfig = Infer<typeof conversationConfigSchema>;
export type InternalApiConfig = Infer<typeof internalApiConfigSchema>;
export type SchedulerConfig = Infer<typeof schedulerConfigSchema>;
export type ShellConfig = Infer<typeof shellConfigSchema>;
export type LocalFilesConfig = Infer<typeof localFilesConfigSchema>;
export type ChatFilesConfig = Infer<typeof chatFilesConfigSchema>;
export type ComfyConfig = Infer<typeof comfyConfigSchema>;
export type ComfyTemplateConfig = Infer<typeof comfyTemplateConfigSchema>;
export type SearchConfig = Infer<typeof searchConfigSchema>;
export type BackupConfig = Infer<typeof backupConfigSchema>;
export type ContentSafetyConfig = Infer<typeof contentSafetyConfigSchema>;

export interface ConfigSummary {
  appName: string;
  runtimeNodeEnv: string;
  configuredNodeEnv: string;
  logLevel: string;
  oneBotEnabled: boolean;
  oneBotWsUrl: string;
  oneBotHttpUrl: string;
  dataDir: string;
  configDir: string;
  instanceName: string | null;
  internalApiEnabled: boolean;
  internalApiPort: number;
  searchEnabled: boolean;
  searchProvider: string;
  browserEnabled: boolean;
  whitelistEnabled: boolean;
  userWhitelistSize: number;
  groupWhitelistSize: number;
}

import { createSchemaTemplate, parseConfig, s, type Infer } from "#data/schema/index.ts";

const emptyObject = () => ({} as never);
const modelProfileSchema = s.object({
  provider: s.string().trim().nonempty().dynamicRef("llm_provider_names"),
  model: s.string().trim().nonempty(),
  modelType: s.enum(["chat", "transcription", "image_generation"] as const).default("chat"),
  supportsThinking: s.boolean().default(false),
  thinkingControllable: s.boolean().default(true),
  supportsVision: s.boolean().default(false),
  supportsAudioInput: s.boolean().default(false),
  supportsSearch: s.boolean().default(false),
  supportsTools: s.boolean().default(true),
  returnReasoningContentForAllMessages: s.boolean().default(false),
  returnReasoningContentForSameRoundMessages: s.boolean().default(true)
}).default(emptyObject);

const createModelRefListSchema = () => s.oneOrMany(s.string().trim().nonempty().dynamicRef("llm_model_names")).min(1);

const onebotConfigSchema = s.object({
  enabled: s.boolean().default(true),
  wsUrl: s.string().url().default("ws://127.0.0.1:3001"),
  httpUrl: s.string().url().default("http://127.0.0.1:3000"),
  accessToken: s.string().trim().nonempty().optional()
}).default(emptyObject);

const proxyDetailSchema = s.object({
  type: s.enum(["http", "https", "socks5"] as const),
  host: s.string().trim().nonempty(),
  port: s.number().int().positive(),
  username: s.string().trim().nonempty().optional(),
  password: s.string().trim().nonempty().optional()
});

const proxyConfigSchema = s.object({
  http: proxyDetailSchema.optional(),
  https: proxyDetailSchema.optional()
}).default(emptyObject);

const llmTurnPlannerConfigSchema = s.object({
  enabled: s.boolean().default(true),
  modelRef: createModelRefListSchema().default(["turnPlanner"]),
  timeoutMs: s.number().int().positive().default(20000),
  enableThinking: s.boolean().default(false),
  recentMessageCount: s.number().int().positive().default(6),
  maxWaitPasses: s.number().int().min(0).default(1),
  supplementToolsets: s.boolean().default(true)
}).default(emptyObject);

const llmImageCaptionerConfigSchema = s.object({
  enabled: s.boolean().default(true),
  modelRef: createModelRefListSchema().default(["imageCaptioner"]),
  timeoutMs: s.number().int().positive().default(30000),
  enableThinking: s.boolean().default(false),
  maxConcurrency: s.number().int().positive().default(2)
}).default(emptyObject);

const llmAudioTranscriptionConfigSchema = s.object({
  enabled: s.boolean().default(true),
  modelRef: createModelRefListSchema().default(["transcription"]),
  timeoutMs: s.number().int().positive().default(30000),
  enableThinking: s.boolean().default(false),
  maxConcurrency: s.number().int().positive().default(2)
}).default(emptyObject);

const llmDebugDumpSchema = s.object({
  enabled: s.boolean().default(false)
}).default(emptyObject);

const llmMainRoutingConfigSchema = s.object({
  enabled: s.boolean().default(true),
  smallModelRef: createModelRefListSchema().default(["main"]),
  largeModelRef: createModelRefListSchema().default(["main"]),
  timeoutMs: s.number().int().positive().default(300000),
  enableThinking: s.boolean().default(true)
}).default(emptyObject);

const llmProviderFeatureFlagSchema = s.object({
  type: s.literal("flag"),
  path: s.string().trim().nonempty()
}).strict();

const llmProviderFeatureBuiltinToolSchema = s.object({
  type: s.literal("builtin_tool"),
  tool: s.object({}).passthrough()
}).strict();

const llmProviderFeatureSchema = s.union([
  llmProviderFeatureFlagSchema,
  llmProviderFeatureBuiltinToolSchema
]);

const llmProviderFeaturesSchema = s.object({
  thinking: llmProviderFeatureSchema.optional(),
  search: llmProviderFeatureSchema.optional()
}).default(emptyObject);

const llmProviderSchema = s.object({
  type: s.enum(["openai", "google", "vertex", "vertex_express", "dashscope", "lmstudio"] as const).default("openai"),
  baseUrl: s.string().url().nonempty().optional(),
  apiKey: s.string().trim().nonempty().optional(),
  proxy: s.boolean().default(false),
  harmBlockThreshold: s.enum([
    "BLOCK_NONE",
    "BLOCK_ONLY_HIGH",
    "BLOCK_MEDIUM_AND_ABOVE",
    "BLOCK_LOW_AND_ABOVE",
    "HARM_BLOCK_THRESHOLD_UNSPECIFIED"
  ] as const).default("BLOCK_NONE"),
  features: llmProviderFeaturesSchema
}).default(emptyObject);

const conversationConfigSchema = s.object({
  historyWindow: s.object({
    maxRecentMessages: s.number().int().positive().default(50),
    maxImageReferences: s.number().int().positive().default(5)
  }).default(emptyObject),
  images: s.object({
    maxSerializedPixels: s.number().int().positive().default(1024 ** 2),
    maxCachedFiles: s.number().int().positive().default(100)
  }).default(emptyObject),
  debounce: s.object({
    defaultBaseSeconds: s.number().positive().default(6),
    minBaseSeconds: s.number().positive().default(5),
    maxBaseSeconds: s.number().positive().default(20),
    smoothingFactor: s.number().min(0).max(1).default(0.3),
    finalMultiplier: s.number().positive().default(1.5),
    plannerWaitMultiplier: s.number().positive().default(2),
    randomRatioMin: s.number().min(0.5).max(1).default(0.8),
    randomRatioMax: s.number().min(1).max(2).default(1.25)
  }).default(emptyObject),
  historyCompression: s.object({
    enabled: s.boolean().default(true),
    triggerMessageCount: s.number().int().positive().default(24),
    retainMessageCount: s.number().int().positive().default(8)
  }).default(emptyObject),
  group: s.object({
    requireAtMention: s.boolean().default(true)
  }).default(emptyObject)
}).default(emptyObject);

const internalApiWebuiConfigSchema = s.object({
  enabled: s.boolean().default(false),
  port: s.number().int().positive().default(3031),
  allowedHosts: s.array(s.string().trim().nonempty()).default([])
}).default(emptyObject);

const internalApiConfigSchema = s.object({
  enabled: s.boolean().default(false),
  port: s.number().int().positive().default(3030),
  webui: internalApiWebuiConfigSchema
}).default(emptyObject);

const schedulerConfigSchema = s.object({
  enabled: s.boolean().default(true),
  defaultTimezone: s.string().trim().nonempty().default("Asia/Shanghai")
}).default(emptyObject);

const shellConfigSchema = s.object({
  enabled: s.boolean().default(false),
  defaultTimeoutMs: s.number().int().positive().default(120000),
  maxTimeoutMs: s.number().int().positive().default(600000),
  maxOutputChars: s.number().int().positive().default(12000),
  sessionTtlMs: s.union([s.number().int().positive(), s.literal(null)]).default(null)
}).default(emptyObject);

const localFilesConfigSchema = s.object({
  enabled: s.boolean().default(true),
  root: s.string().trim().nonempty().default("data"),
  maxPatchFileBytes: s.number().int().positive().default(512 * 1024)
}).default(emptyObject);

const chatFilesConfigSchema = s.object({
  enabled: s.boolean().default(true),
  root: s.string().trim().nonempty().default("chat-files"),
  maxUploadBytes: s.number().int().positive().default(32 * 1024 * 1024),
  gcGracePeriodMs: s.number().int().min(0).default(7 * 24 * 60 * 60 * 1000)
}).default(emptyObject);

const comfyTemplateParameterBindingsSchema = s.object({
  positivePromptPath: s.string().trim().nonempty(),
  widthPath: s.string().trim().nonempty(),
  heightPath: s.string().trim().nonempty()
}).strict();

const comfyTemplateResultPolicySchema = s.object({
  maxAutoIterations: s.number().int().min(0).default(1),
  defaultActionHint: s.enum(["decide_by_model"] as const).default("decide_by_model")
}).default(emptyObject);

const comfyTemplateConfigSchema = s.object({
  id: s.string().trim().nonempty(),
  label: s.string().trim().nonempty(),
  workflowFile: s.string().trim().nonempty(),
  enabled: s.boolean().default(true),
  description: s.string().trim().nonempty().optional(),
  parameterBindings: comfyTemplateParameterBindingsSchema,
  resultPolicy: comfyTemplateResultPolicySchema
}).strict();

const comfyAspectRatioSchema = s.object({
  width: s.number().int().positive(),
  height: s.number().int().positive()
}).strict();

const comfyConfigSchema = s.object({
  enabled: s.boolean().default(false),
  apiBaseUrl: s.string().url().default("http://192.168.0.223:8188"),
  templateRoot: s.string().trim().nonempty().default("templates/comfyui"),
  submitTimeoutMs: s.number().int().positive().default(15000),
  pollIntervalMs: s.number().int().positive().default(3000),
  maxConcurrentTasks: s.number().int().positive().default(2),
  aspectRatios: s.record(
    s.string().trim().nonempty(),
    comfyAspectRatioSchema
  ).default({
    "1:1": {
      width: 1024,
      height: 1024
    }
  }),
  templates: s.array(comfyTemplateConfigSchema).default([])
}).default(emptyObject);

const googleGroundingSearchSchema = s.object({
  enabled: s.boolean().default(false),
  proxy: s.boolean().default(false),
  apiKey: s.string().trim().nonempty().optional(),
  model: s.string().trim().nonempty().default("gemini-2.5-flash"),
  timeoutMs: s.number().int().positive().default(30000),
  maxSources: s.number().int().positive().default(8),
  resolveRedirectUrls: s.boolean().default(true)
}).default(emptyObject);

const aliyunIqsSearchSchema = s.object({
  enabled: s.boolean().default(false),
  proxy: s.boolean().default(false),
  apiKey: s.string().trim().nonempty().optional(),
  timeoutMs: s.number().int().positive().default(30000),
  defaultNumResults: s.number().int().min(1).max(50).default(8),
  maxNumResults: s.number().int().min(1).max(50).default(20),
  defaultIncludeMainText: s.boolean().default(false),
  defaultIncludeMarkdownText: s.boolean().default(false)
}).default(emptyObject);

const searchConfigSchema = s.object({
  googleGrounding: googleGroundingSearchSchema,
  aliyunIqs: aliyunIqsSearchSchema
}).default(emptyObject);

const playwrightSearchSchema = s.object({
  enabled: s.boolean().default(false),
  proxy: s.boolean().default(false),
  headless: s.boolean().default(true),
  actionTimeoutMs: s.number().int().positive().default(15000),
  navigationTimeoutMs: s.number().int().positive().default(30000),
  maxSnapshotChars: s.number().int().positive().default(20000),
  persistSessionState: s.boolean().default(true),
  persistSessionStorage: s.boolean().default(true),
  profileAutoSaveDebounceMs: s.number().int().min(0).default(250),
  profileMaxCount: s.number().int().positive().default(24),
  screenshotMaxBytes: s.number().int().positive().default(5 * 1024 * 1024)
}).default(emptyObject);

const browserConfigSchema = s.object({
  enabled: s.boolean().default(false),
  browseMaxContentChars: s.number().int().positive().default(16000),
  sessionTtlMs: s.number().int().positive().default(3600000),
  playwright: playwrightSearchSchema
}).default(emptyObject);

const backupConfigSchema = s.object({
  profileRotateLimit: s.number().int().positive().default(10)
}).default(emptyObject);

const llmRuntimeConfigSchema = s.object({
  enabled: s.boolean().default(false),
  timeoutMs: s.number().int().positive().default(300000),
  firstTokenTimeoutMs: s.number().int().positive().default(30000),
  toolCallMaxIterations: s.number().int().positive().default(8),
  mainRouting: llmMainRoutingConfigSchema,
  summarizer: s.object({
    enabled: s.boolean().default(true),
    modelRef: createModelRefListSchema().default(["summarizer"]),
    timeoutMs: s.number().int().positive().default(45000),
    enableThinking: s.boolean().default(false)
  }).default(emptyObject),
  imageCaptioner: llmImageCaptionerConfigSchema,
  audioTranscription: llmAudioTranscriptionConfigSchema,
  turnPlanner: llmTurnPlannerConfigSchema,
  debugDump: llmDebugDumpSchema
}).default(emptyObject);

export const llmProviderCatalogSchema = s.record(
  s.string().trim().nonempty(),
  llmProviderSchema
).default({});

export const llmModelCatalogSchema = s.record(
  s.string().trim().nonempty(),
  modelProfileSchema
).default({});

export const llmCatalogSchema = s.object({
  providers: llmProviderCatalogSchema,
  models: llmModelCatalogSchema
}).default(emptyObject);

export const fileConfigSchema = s.object({
  appName: s.string().trim().nonempty().default("llm-bot"),
  nodeEnv: s.string().trim().nonempty().default("development"),
  logLevel: s.string().trim().nonempty().default("info"),
  dataDir: s.string().trim().nonempty().default("data"),
  proxy: proxyConfigSchema,
  onebot: onebotConfigSchema,
  llm: llmRuntimeConfigSchema,
  conversation: conversationConfigSchema,
  whitelist: s.object({
    enabled: s.boolean().default(true)
  }).default(emptyObject),
  internalApi: internalApiConfigSchema,
  scheduler: schedulerConfigSchema,
  shell: shellConfigSchema,
  localFiles: localFilesConfigSchema,
  chatFiles: chatFilesConfigSchema,
  comfy: comfyConfigSchema,
  search: searchConfigSchema,
  browser: browserConfigSchema,
  backup: backupConfigSchema
});

export const configRuntimeSchema = s.object({
  configDir: s.string().trim().nonempty(),
  globalExampleConfigPath: s.string().trim().nonempty(),
  globalConfigPath: s.string().trim().nonempty(),
  llmProviderCatalogPath: s.string().trim().nonempty(),
  llmModelCatalogPath: s.string().trim().nonempty(),
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

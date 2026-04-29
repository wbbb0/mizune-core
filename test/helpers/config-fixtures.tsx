import {
  createEmptyFileConfig,
  createEmptyLlmCatalogConfig,
  fileConfigSchema,
  llmCatalogSchema,
  type FileConfig,
  type LlmCatalogConfig
} from "../../src/config/configModel.ts";
import { deepMergeReplaceArrays, parseConfig } from "../../src/data/schema/index.ts";
import type { AppConfig } from "../../src/config/config.ts";
import { createTempDir } from "./temp-paths.ts";

type DeepPartial<T> =
  T extends readonly (infer U)[]
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

type TestAppConfigOverrides = DeepPartial<FileConfig> & {
  llm?: DeepPartial<FileConfig["llm"]> & DeepPartial<LlmCatalogConfig>;
};

const baseTestFileConfigOverrides: DeepPartial<FileConfig> = {
  appName: "llm-bot-test",
  nodeEnv: "test",
  logLevel: "silent",
  llm: {
    enabled: false,
    routingPreset: "test",
    timeoutMs: 1000,
    firstTokenTimeoutMs: 1000,
    toolCallMaxIterations: 8,
    mainRouting: {
      enabled: true,
      timeoutMs: 1000,
      enableThinking: false
    },
    summarizer: {
      enabled: false,
      timeoutMs: 1000,
      enableThinking: false
    },
    sessionCaptioner: {
      enabled: true,
      timeoutMs: 1000,
      enableThinking: false
    },
    imageInspector: {
      enabled: true,
      timeoutMs: 1000,
      enableThinking: false,
      maxConcurrency: 2
    },
    turnPlanner: {
      enabled: false,
      timeoutMs: 1000,
      recentMessageCount: 4,
      enableThinking: false
    },
    audioTranscription: {
      enabled: false,
      timeoutMs: 1000,
      enableThinking: false,
      maxConcurrency: 2
    },
    debugDump: {
      enabled: false
    }
  },
  conversation: {
    historyWindow: {
      maxRecentMessages: 10,
      maxImageReferences: 2
    },
    debounce: {
      defaultBaseSeconds: 1,
      minBaseSeconds: 1,
      maxBaseSeconds: 2,
      smoothingFactor: 0.3,
      finalMultiplier: 1,
      randomRatioMin: 1,
      randomRatioMax: 1
    },
    historyCompression: {
      enabled: false,
      triggerTokens: 2000,
      retainTokens: 500,
      retainMessageCount: 3,
      tokenEstimation: { cjkTokens: 2, nonAsciiTokens: 1, asciiTokens: 0.25 }
    }
  },
  whitelist: {
    enabled: false
  },
  internalApi: {
    enabled: false,
    port: 3030
  },
  scheduler: {
    enabled: false,
    defaultTimezone: "Asia/Shanghai"
  },
  shell: {
    enabled: false,
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 5000,
    maxOutputChars: 4000,
    sessionTtlMs: null
  },
  localFiles: {
    enabled: true,
    root: "data",
    maxPatchFileBytes: 512 * 1024
  },
  chatFiles: {
    enabled: true,
    root: "chat-files",
    maxUploadBytes: 32 * 1024 * 1024,
    gcGracePeriodMs: 7 * 24 * 60 * 60 * 1000
  },
  search: {
    googleGrounding: {
      enabled: false,
      proxy: false,
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      timeoutMs: 1000,
      maxSources: 8,
      resolveRedirectUrls: true
    },
    aliyunIqs: {
      enabled: false,
      proxy: false,
      apiKey: "test-aliyun-key",
      timeoutMs: 1000,
      defaultNumResults: 8,
      maxNumResults: 20,
      defaultIncludeMainText: false,
      defaultIncludeMarkdownText: false
    }
  },
  browser: {
    enabled: false,
    browseMaxContentChars: 16000,
    sessionTtlMs: 3600000,
    playwright: {
      enabled: false,
      proxy: false,
      headless: true,
      actionTimeoutMs: 1000,
      navigationTimeoutMs: 1000,
      maxSnapshotChars: 12000,
      persistSessionState: true,
      persistSessionStorage: true,
      profileAutoSaveDebounceMs: 10,
      profileMaxCount: 24,
      screenshotMaxBytes: 1024 * 1024
    }
  },
  backup: {
    profileRotateLimit: 2
  }
};

const baseTestCatalogOverrides: DeepPartial<LlmCatalogConfig> = {
  providers: {
    test: {
      type: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      proxy: false
    }
  },
  models: {
    main: {
      provider: "test",
      model: "fake",
      modelType: "chat",
      supportsThinking: false,
      thinkingControllable: true,
      supportsVision: false,
      supportsAudioInput: false,
      supportsSearch: false,
      supportsTools: true,
      preserveThinking: false
    },
    sessionCaptioner: {
      provider: "test",
      model: "fake-captain",
      modelType: "chat",
      supportsThinking: true,
      thinkingControllable: true,
      supportsVision: false,
      supportsAudioInput: false,
      supportsSearch: false,
      supportsTools: true,
      preserveThinking: false
    },
    transcription: {
      provider: "test",
      model: "fake-transcription",
      modelType: "transcription",
      supportsThinking: false,
      thinkingControllable: true,
      supportsVision: false,
      supportsAudioInput: true,
      supportsSearch: false,
      supportsTools: false,
      preserveThinking: false
    }
  },
  routingPresets: {
    test: {
      mainSmall: ["main"],
      mainLarge: ["main"],
      summarizer: ["main"],
      sessionCaptioner: ["sessionCaptioner"],
      imageCaptioner: ["main"],
      imageInspector: ["main"],
      audioTranscription: ["transcription"],
      turnPlanner: ["main"]
    }
  }
};

const baseTestFileConfig = parseConfig(
  fileConfigSchema,
  deepMergeReplaceArrays(createEmptyFileConfig(), baseTestFileConfigOverrides),
);

const baseTestCatalogConfig = parseConfig(
  llmCatalogSchema,
  deepMergeReplaceArrays(createEmptyLlmCatalogConfig(), baseTestCatalogOverrides),
);

function normalizeModelOverrides(
  runtimeOverrides: DeepPartial<FileConfig>,
  catalogOverrides: DeepPartial<LlmCatalogConfig>
): {
  runtimeOverrides: DeepPartial<FileConfig>;
  catalogOverrides: DeepPartial<LlmCatalogConfig>;
} {
  const normalizedRuntime = deepMergeReplaceArrays({} as DeepPartial<FileConfig>, runtimeOverrides);
  const normalizedCatalog = deepMergeReplaceArrays({} as DeepPartial<LlmCatalogConfig>, catalogOverrides);
  const overrideModels = normalizedCatalog.models;
  const baseModels = baseTestCatalogConfig.models;

  if (overrideModels == null) {
    return {
      runtimeOverrides: normalizedRuntime,
      catalogOverrides: normalizedCatalog
    };
  }

  for (const [modelRef, profiles] of Object.entries(overrideModels)) {
    if (!profiles || Array.isArray(profiles)) {
      continue;
    }

    const baseProfile = baseModels[modelRef] ?? baseModels.main ?? {};
    overrideModels[modelRef] = deepMergeReplaceArrays(baseProfile, profiles);
  }

  return {
    runtimeOverrides: normalizedRuntime,
    catalogOverrides: normalizedCatalog
  };
}

export function createTestAppConfig(overrides: TestAppConfigOverrides = {}): AppConfig {
  const runtimeOverrides = deepMergeReplaceArrays({} as DeepPartial<FileConfig>, overrides as DeepPartial<FileConfig>);
  const llmOverride = overrides.llm;
  const catalogOverrides: DeepPartial<LlmCatalogConfig> = {};
  if (llmOverride?.providers) {
    catalogOverrides.providers = llmOverride.providers;
  }
  if (llmOverride?.models) {
    catalogOverrides.models = llmOverride.models;
  }
  if (llmOverride?.routingPresets) {
    catalogOverrides.routingPresets = llmOverride.routingPresets;
  }
  if (runtimeOverrides.llm) {
    delete (runtimeOverrides.llm as Record<string, unknown>).providers;
    delete (runtimeOverrides.llm as Record<string, unknown>).models;
    delete (runtimeOverrides.llm as Record<string, unknown>).routingPresets;
  }

  const normalized = normalizeModelOverrides(runtimeOverrides, catalogOverrides);
  const fileConfig = parseConfig(
    fileConfigSchema,
    deepMergeReplaceArrays(baseTestFileConfig, normalized.runtimeOverrides),
  );
  const catalogConfig = parseConfig(
    llmCatalogSchema,
    deepMergeReplaceArrays(baseTestCatalogConfig, normalized.catalogOverrides),
  );

  const configDir = createTempDir("llm-bot-test-config");

  return {
    ...fileConfig,
    llm: {
      ...fileConfig.llm,
      ...catalogConfig
    },
    whitelist: {
      enabled: fileConfig.whitelist.enabled
    },
    configRuntime: {
      configDir,
      globalExampleConfigPath: `${configDir}/global.example.yml`,
      globalConfigPath: `${configDir}/global.yml`,
      llmProviderCatalogPath: `${configDir}/llm.providers.yml`,
      llmModelCatalogPath: `${configDir}/llm.models.yml`,
      llmRoutingPresetCatalogPath: `${configDir}/llm.routing-presets.yml`,
      instanceName: "test",
      instanceConfigPath: `${configDir}/instances/test.yml`,
      loadedConfigPaths: []
    }
  };
}

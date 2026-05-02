import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { getModelRefsForRole } from "../../src/llm/shared/modelRouting.ts";
import { withConfigDir, writeLlmCatalog, writeDefaultInstanceYaml, writeYaml } from "../helpers/config-test-support.tsx";

  test("loadConfig keeps default refs without implicit model profiles", async () => {
    await withConfigDir("llm-bot-config-default-ref-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.example.yml"), {
        llm: {
          enabled: true,
          routingPreset: "should-not-be-read"
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: false,
          summarizer: {
            enabled: true,
            timeoutMs: 45000,
            enableThinking: false
          },
          turnPlanner: {
            enabled: true,
            timeoutMs: 20000,
            recentMessageCount: 6,
            enableThinking: false
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.llm.routingPreset, "");
      assert.deepEqual(getModelRefsForRole(config, "main_small"), []);
      assert.equal(config.llm.turnPlanner.supplementToolsets, true);
      assert.equal(config.llm.sessionCaptioner.timeoutMs, 15000);
      assert.equal(config.llm.imageInspector.enabled, true);
      assert.equal(config.llm.imageInspector.timeoutMs, 45000);
      assert.equal(config.llm.imageInspector.enableThinking, false);
      assert.equal(config.llm.imageInspector.maxConcurrency, 2);
      assert.deepEqual(config.llm.providers, {});
      assert.deepEqual(config.llm.models, {});
      assert.deepEqual(config.llm.routingPresets, {
        default: {
          mainSmall: [],
          mainLarge: [],
          summarizer: [],
          sessionCaptioner: [],
          imageCaptioner: [],
          imageInspector: [],
          audioTranscription: [],
          turnPlanner: [],
          embedding: []
        }
      });
      assert.equal(config.dataDir, "data/default");
    });
  });

  test("loadConfig ignores global.example.yml during runtime loading", async () => {
    await withConfigDir("llm-bot-config-global-example-ignored-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.example.yml"), {
        appName: "example-only",
        internalApi: {
          enabled: true,
          port: 9999
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        appName: "runtime-app",
        internalApi: {
          enabled: false,
          port: 3130
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.appName, "runtime-app");
      assert.equal(config.internalApi.enabled, false);
      assert.equal(config.internalApi.port, 3130);
      assert.equal(config.configRuntime.instanceName, "default");
      assert.equal(config.configRuntime.globalExampleConfigPath, join(configDir, "global.example.yml"));
      assert.deepEqual(config.configRuntime.loadedConfigPaths, [
        join(configDir, "global.yml"),
        join(configDir, "instances", "default.yml")
      ]);
    });
  });

  test("loadConfig enables webui auth by default", async () => {
    await withConfigDir("llm-bot-config-webui-auth-default-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        internalApi: {
          enabled: true,
          webui: {
            enabled: true
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.internalApi.webui.enabled, true);
      assert.equal(config.internalApi.webui.auth.enabled, true);
    });
  });

  test("loadConfig keeps outbound streaming split enabled by default", async () => {
    await withConfigDir("llm-bot-config-outbound-split-default-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        conversation: {
          outbound: {
            disableStreamingSplit: false
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.ok(!("instantReply" in config.conversation.outbound));
      assert.equal(config.conversation.outbound.disableStreamingSplit, false);
    });
  });

  test("loadConfig keeps persona initialization enabled by default", async () => {
    await withConfigDir("llm-bot-config-persona-setup-default-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {});

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.conversation.setup.skipPersonaInitialization, false);
    });
  });

  test("loadConfig applies preserveThinking defaults for model profiles", async () => {
    await withConfigDir("llm-bot-config-preserve-thinking-defaults-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeLlmCatalog(configDir, {
        providers: {
          test: {
            baseUrl: "https://example.com/v1",
            apiKey: "test-key"
          }
        },
        models: {
          main: {
            provider: "test",
            model: "gpt-test"
          },
          transcription: {
            provider: "test",
            model: "gpt-test-transcription",
            modelType: "transcription"
          }
        },
        routingPresets: {
          test: {
            mainSmall: "main",
            mainLarge: "main",
            summarizer: "main",
            sessionCaptioner: "main",
            imageCaptioner: "main",
            imageInspector: "main",
            audioTranscription: "transcription",
            turnPlanner: "main"
          }
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: true,
          routingPreset: "test",
          summarizer: {
            enabled: true,
            timeoutMs: 45000,
            enableThinking: false
          },
          sessionCaptioner: {
            enabled: true,
            timeoutMs: 15000,
            enableThinking: false
          },
          turnPlanner: {
            enabled: true,
            timeoutMs: 20000,
            recentMessageCount: 6,
            enableThinking: false
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.llm.models.main?.supportsAudioInput, false);
      assert.equal(config.llm.models.main?.supportsSearch, false);
      assert.equal(config.llm.models.main?.thinkingControllable, true);
      assert.equal(config.llm.models.main?.preserveThinking, false);
      assert.equal(config.llm.providers.test?.harmBlockThreshold, "BLOCK_NONE");
      assert.deepEqual(config.llm.providers.test?.features, {});
    });
  });

  test("loadConfig preserves explicit provider features and model capability flags", async () => {
    await withConfigDir("llm-bot-config-provider-feature-flags-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeLlmCatalog(configDir, {
        providers: {
          test: {
            baseUrl: "https://example.com/v1",
            apiKey: "test-key",
            harmBlockThreshold: "BLOCK_LOW_AND_ABOVE",
            features: {
              thinking: {
                type: "flag",
                path: "extra_body.enable_thinking"
              },
              search: {
                type: "builtin_tool",
                tool: {
                  type: "web_search_preview"
                }
              }
            }
          }
        },
        models: {
          main: {
            provider: "test",
            model: "gpt-test",
            thinkingControllable: false,
            supportsAudioInput: true,
            supportsSearch: true
          },
          transcription: {
            provider: "test",
            model: "gpt-test-transcription",
            modelType: "transcription"
          }
        },
        routingPresets: {
          test: {
            mainSmall: "main",
            mainLarge: "main",
            summarizer: "main",
            sessionCaptioner: "main",
            imageCaptioner: "main",
            imageInspector: "main",
            audioTranscription: "transcription",
            turnPlanner: "main"
          }
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: true,
          routingPreset: "test",
          summarizer: {
            enabled: true,
            timeoutMs: 45000,
            enableThinking: false
          },
          sessionCaptioner: {
            enabled: true,
            timeoutMs: 15000,
            enableThinking: false
          },
          turnPlanner: {
            enabled: true,
            timeoutMs: 20000,
            recentMessageCount: 6,
            enableThinking: false
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.llm.providers.test?.harmBlockThreshold, "BLOCK_LOW_AND_ABOVE");
      assert.deepEqual(config.llm.providers.test?.features, {
        thinking: {
          type: "flag",
          path: "extra_body.enable_thinking"
        },
        search: {
          type: "builtin_tool",
          tool: {
            type: "web_search_preview"
          }
        }
      });
      assert.equal(config.llm.models.main?.supportsAudioInput, true);
      assert.equal(config.llm.models.main?.supportsSearch, true);
      assert.equal(config.llm.models.main?.thinkingControllable, false);
    });
  });

  test("loadConfig applies default browser session ttl", async () => {
    await withConfigDir("llm-bot-config-browser-session-ttl-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        browser: {
          enabled: true
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.browser.sessionTtlMs, 3600000);
    });
  });

  test("loadConfig applies default shell session ttl as null", async () => {
    await withConfigDir("llm-bot-config-shell-session-ttl-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        shell: {
          enabled: true
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.shell.sessionTtlMs, null);
      assert.equal(config.shell.terminalEvents.enabled, true);
      assert.equal(config.shell.terminalEvents.inputDetectionDebounceMs, 800);
      assert.equal(config.shell.terminalEvents.inputConfirmationMs, 1200);
      assert.equal(config.shell.terminalEvents.inputPromptCooldownMs, 30000);
      assert.equal(config.shell.terminalEvents.inputSuppressionAfterWriteMs, 1200);
      assert.equal(config.shell.terminalEvents.detectionTailMaxChars, 8000);
    });
  });

  test("loadConfig applies OneBot typing defaults", async () => {
    await withConfigDir("llm-bot-config-onebot-typing-defaults-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        onebot: {
          enabled: true
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.onebot.provider, "generic");
      assert.equal(config.onebot.typing.enabled, true);
      assert.equal(config.onebot.typing.private, true);
      assert.equal(config.onebot.typing.group, false);
    });
  });

  test("loadConfig applies OneBot history backfill defaults", async () => {
    await withConfigDir("llm-bot-config-onebot-history-backfill-defaults-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        onebot: {
          provider: "napcat"
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.onebot.historyBackfill.enabled, true);
      assert.equal(config.onebot.historyBackfill.maxMessagesPerSession, 20);
      assert.equal(config.onebot.historyBackfill.maxTotalMessages, 100);
      assert.equal(config.onebot.historyBackfill.requestDelayMs, 100);
    });
  });

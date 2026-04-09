import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import {
  runCase,
  withConfigDir,
  writeLlmCatalog,
  writeDefaultInstanceYaml,
  writeYaml
} from "../helpers/config-test-support.tsx";

async function main() {
  await runCase("loadConfig keeps default refs without implicit model profiles", async () => {
    await withConfigDir("llm-bot-config-default-ref-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.example.yml"), {
        llm: {
          enabled: true,
          mainRouting: {
            smallModelRef: "should-not-be-read"
          }
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

      assert.deepEqual(config.llm.mainRouting.smallModelRef, ["main"]);
      assert.deepEqual(config.llm.mainRouting.largeModelRef, ["main"]);
      assert.deepEqual(config.llm.summarizer.modelRef, ["summarizer"]);
      assert.deepEqual(config.llm.turnPlanner.modelRef, ["turnPlanner"]);
      assert.deepEqual(config.llm.providers, {});
      assert.deepEqual(config.llm.models, {});
      assert.equal(config.dataDir, "data/default");
    });
  });

  await runCase("loadConfig ignores global.example.yml during runtime loading", async () => {
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

  await runCase("loadConfig applies reasoning relay defaults for model profiles", async () => {
    await withConfigDir("llm-bot-config-reasoning-defaults-test", async (configDir) => {
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
          }
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: true,
          mainRouting: {
            smallModelRef: "main",
            largeModelRef: "main"
          },
          summarizer: {
            enabled: true,
            modelRef: "main",
            timeoutMs: 45000,
            enableThinking: false
          },
          turnPlanner: {
            enabled: true,
            modelRef: "main",
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
      assert.equal(config.llm.models.main?.returnReasoningContentForAllMessages, false);
      assert.equal(config.llm.models.main?.returnReasoningContentForSameRoundMessages, true);
      assert.equal(config.llm.providers.test?.harmBlockThreshold, "BLOCK_NONE");
      assert.deepEqual(config.llm.providers.test?.features, {});
    });
  });

  await runCase("loadConfig preserves explicit provider features and model capability flags", async () => {
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
          }
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: true,
          mainRouting: {
            smallModelRef: "main",
            largeModelRef: "main"
          },
          summarizer: {
            enabled: true,
            modelRef: "main",
            timeoutMs: 45000,
            enableThinking: false
          },
          turnPlanner: {
            enabled: true,
            modelRef: "main",
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

  await runCase("loadConfig applies default browser session ttl", async () => {
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

  await runCase("loadConfig applies default shell session ttl as null", async () => {
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
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

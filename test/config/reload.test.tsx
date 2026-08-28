import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../../src/config/config.ts";
import { ConfigManager } from "../../src/config/configManager.ts";
import {
  getModelRefsForRole,
  getRoutingPresetHistoryWindow,
  getRoutingPresetTokenLimits
} from "../../src/llm/shared/modelRouting.ts";
import { sleep, withConfigDir, writeLlmCatalog, writeYaml } from "../helpers/config-test-support.tsx";

  test("config manager reloads changed config files", async () => {
    await withConfigDir("llm-bot-config-reload", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
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
            model: "gpt-test",
            supportsTools: true
          },
          transcription: {
            provider: "test",
            model: "gpt-test-transcription",
            modelType: "transcription"
          }
        },
        routingPresets: {
          reload: {
            mainSmall: "main",
            mainLarge: "main",
            summarizer: "main",
            textInspector: "main",
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
          routingPreset: "reload"
        },
        search: {
          googleGrounding: {
            enabled: false
          }
        },
        browser: {
          enabled: false
        },
        shell: {
          enabled: false
        }
      });
      await writeYaml(join(configDir, "instances", "acc1.yml"), {
        appName: "reload-test"
      });

      const env = {
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      };
      const config = loadConfig(env);

      const logger = pino({ level: "silent" });
      const manager = new ConfigManager(config, logger, env);
      await manager.start();

      let listenerCalled = false;
      manager.subscribe(() => {
        listenerCalled = true;
      });

      await sleep(20);
      await writeYaml(join(configDir, "global.yml"), {
        shell: {
          enabled: true
        },
        search: {
          googleGrounding: {
            enabled: true,
            apiKey: "replace-me"
          }
        }
      });

      const changed = await manager.checkForUpdates();
      manager.stop();

      assert.equal(changed, true);
      assert.equal(listenerCalled, true);
      assert.equal(config.search.googleGrounding.enabled, true);
      assert.equal(config.search.googleGrounding.apiKey, "replace-me");
      assert.equal(config.shell.enabled, true);
    });
  });

  test("config manager defers reload until a write transaction completes", async () => {
    await withConfigDir("llm-bot-config-write-transaction", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
      await writeLlmCatalog(configDir);
      await writeYaml(join(configDir, "global.yml"), { appName: "before" });
      await writeYaml(join(configDir, "instances", "acc1.yml"), {});

      const env = {
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      };
      const config = loadConfig(env);
      const manager = new ConfigManager(config, pino({ level: "silent" }), env);
      await manager.start();

      let listenerCalls = 0;
      manager.subscribe(() => {
        listenerCalls += 1;
      });

      let reloadDuringTransaction = true;
      await manager.runWriteTransaction(async () => {
        await writeYaml(join(configDir, "global.yml"), { appName: "after" });
        reloadDuringTransaction = await manager.checkForUpdates();
      });
      manager.stop();

      assert.equal(reloadDuringTransaction, false);
      assert.equal(config.appName, "after");
      assert.equal(listenerCalls, 1);
    });
  });

  test("config manager serializes concurrent write transactions", async () => {
    await withConfigDir("llm-bot-config-write-transaction-order", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
      await writeLlmCatalog(configDir);
      await writeYaml(join(configDir, "global.yml"), {});
      await writeYaml(join(configDir, "instances", "acc1.yml"), {});

      const env = {
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      };
      const manager = new ConfigManager(
        loadConfig(env),
        pino({ level: "silent" }),
        env
      );
      const events: string[] = [];
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = manager.runWriteTransaction(async () => {
        events.push("first:start");
        markFirstStarted();
        await firstGate;
        events.push("first:end");
      });
      await firstStarted;
      const second = manager.runWriteTransaction(() => {
        events.push("second");
      });

      await Promise.resolve();
      assert.deepEqual(events, ["first:start"]);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(events, ["first:start", "first:end", "second"]);
    });
  });

  test("config manager reloads changed LLM routing preset catalog", async () => {
    await withConfigDir("llm-bot-config-reload-routing-presets", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
      const createTarget = (model: string) => ({ provider: "test", model });
      const createPreset = (modelRef: string) => ({
        mainSmall: [createTarget(modelRef)],
        mainLarge: [createTarget(modelRef)],
        summarizer: [createTarget(modelRef)],
        textInspector: [createTarget(modelRef)],
        sessionCaptioner: [createTarget(modelRef)],
        imageCaptioner: [createTarget(modelRef)],
        imageInspector: [createTarget(modelRef)],
        audioTranscription: [createTarget("transcription")],
        turnPlanner: [createTarget(modelRef)]
      });
      const createPresetWithLimits = (modelRef: string, maxRecentMessages: number, retainTokens: number) => ({
        ...createPreset(modelRef),
        historyWindow: {
          maxRecentMessages,
          maxImageReferences: 5
        },
        tokenLimits: {
          triggerTokens: 150000,
          retainTokens
        }
      });
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
            model: "gpt-test",
            supportsTools: true
          },
          alternate: {
            provider: "test",
            model: "gpt-test-alt",
            supportsTools: true
          },
          transcription: {
            provider: "test",
            model: "gpt-test-transcription",
            modelType: "transcription"
          }
        },
        routingPresets: {
          reload: createPresetWithLimits("main", 80, 7000)
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: true,
          routingPreset: "reload"
        }
      });
      await writeYaml(join(configDir, "instances", "acc1.yml"), {
        appName: "reload-routing-test"
      });

      const env = {
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      };
      const config = loadConfig(env);
      const manager = new ConfigManager(config, pino({ level: "silent" }), env);
      await manager.start();

      assert.deepEqual(getModelRefsForRole(config, "main_small"), ["test/main"]);
      assert.deepEqual(getRoutingPresetHistoryWindow(config), {
        maxRecentMessages: 80,
        maxImageReferences: 5
      });
      assert.deepEqual(getRoutingPresetTokenLimits(config), {
        triggerTokens: 150000,
        retainTokens: 7000
      });

      await sleep(20);
      await writeYaml(join(configDir, "llm.routing-presets.yml"), {
        reload: createPresetWithLimits("alternate", 32, 3000)
      });

      const changed = await manager.checkForUpdates();
      manager.stop();

      assert.equal(changed, true);
      assert.deepEqual(getModelRefsForRole(config, "main_small"), ["test/alternate"]);
      assert.deepEqual(getRoutingPresetHistoryWindow(config), {
        maxRecentMessages: 32,
        maxImageReferences: 5
      });
      assert.deepEqual(getRoutingPresetTokenLimits(config), {
        triggerTokens: 150000,
        retainTokens: 3000
      });
    });
  });

  test("config manager watches configured Comfy template root", async () => {
    await withConfigDir("llm-bot-config-reload-comfy-template-root", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
      await writeLlmCatalog(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: false
        },
        comfy: {
          templateRoot: "custom-comfy-templates"
        }
      });
      await writeYaml(join(configDir, "instances", "acc1.yml"), {
        appName: "reload-template-root-test"
      });

      const env = {
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      };
      const config = loadConfig(env);
      const manager = new ConfigManager(config, pino({ level: "silent" }), env);
      await manager.start();

      await sleep(20);
      await writeYaml(join(configDir, "custom-comfy-templates", "workflow.yml"), {
        updated: true
      });

      const changed = await manager.checkForUpdates();
      manager.stop();

      assert.equal(changed, true);
    });
  });

  test("config manager notices newly created instance config file", async () => {
    await withConfigDir("llm-bot-config-reload-instance-create", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
      await writeLlmCatalog(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: false
        }
      });
      await writeYaml(join(configDir, "instances", "acc1.yml"), {
        shell: {
          enabled: false
        }
      });

      const env = {
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      };
      const config = loadConfig(env);
      const manager = new ConfigManager(config, pino({ level: "silent" }), env);
      await manager.start();

      await sleep(20);
      await writeYaml(join(configDir, "instances", "acc1.yml"), {
        shell: {
          enabled: true
        }
      });

      const changed = await manager.checkForUpdates();
      manager.stop();

      assert.equal(changed, true);
      assert.equal(config.shell.enabled, true);
    });
  });

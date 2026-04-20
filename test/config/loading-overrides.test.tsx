import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { withConfigDir, writeLlmCatalog, writeDefaultInstanceYaml, writeYaml } from "../helpers/config-test-support.tsx";

  test("loadConfig merges global proxy settings and feature proxy switches", async () => {
    await withConfigDir("llm-bot-config-search-proxy-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeLlmCatalog(configDir, {
        providers: {
          test: {
            baseUrl: "https://example.com/v1",
            apiKey: "test-key",
            proxy: true
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
        proxy: {
          http: {
            type: "http",
            host: "127.0.0.1",
            port: 8080
          }
        },
        search: {
          googleGrounding: {
            enabled: true,
            proxy: false,
            model: "gemini-2.5-flash",
            timeoutMs: 30000,
            maxSources: 8,
            resolveRedirectUrls: true
          }
        },
        browser: {
          enabled: true,
          playwright: {
            enabled: true,
            proxy: false
          }
        }
      });
      await writeYaml(join(configDir, "search-override.yml"), {
        proxy: {
          https: {
            type: "socks5",
            host: "127.0.0.1",
            port: 8443
          }
        },
        search: {
          googleGrounding: {
            proxy: true,
            apiKey: "test-google-key"
          }
        },
        browser: {
          playwright: {
            proxy: true
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE_FILE: "search-override.yml"
      });

      assert.equal(config.proxy.http?.type, "http");
      assert.equal(config.proxy.http?.host, "127.0.0.1");
      assert.equal(config.proxy.http?.port, 8080);
      assert.equal(config.proxy.https?.type, "socks5");
      assert.equal(config.proxy.https?.port, 8443);
      assert.equal(config.search.googleGrounding.proxy, true);
      assert.equal(config.browser.playwright.proxy, true);
      assert.equal(config.llm.providers.test?.proxy, true);
      assert.equal(config.search.googleGrounding.apiKey, "test-google-key");
    });
  });

  test("loadConfig keeps provider catalog independent from runtime overrides", async () => {
    await withConfigDir("llm-bot-config-provider-catalog-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeLlmCatalog(configDir, {
        providers: {
          dashscope: {
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            apiKey: "dash-key"
          }
        },
        models: {
          main: {
            provider: "dashscope",
            model: "qwen3.5-plus"
          },
          turnPlanner: {
            provider: "dashscope",
            model: "qwen3.5-flash"
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
            modelRef: "turnPlanner",
            timeoutMs: 45000,
            enableThinking: false
          },
          turnPlanner: {
            enabled: true,
            modelRef: "turnPlanner",
            timeoutMs: 20000,
            recentMessageCount: 6,
            enableThinking: false
          },
          sessionCaptioner: {
            enabled: true,
            modelRef: "turnPlanner",
            timeoutMs: 15000,
            enableThinking: false
          }
        }
      });
      await writeYaml(join(configDir, "instances-acc2.yml"), {
        llm: {
          mainRouting: {
            smallModelRef: "qwen35_lan",
            largeModelRef: "qwen35_lan"
          },
          turnPlanner: {
            modelRef: "qwen35_lan"
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE_FILE: "instances-acc2.yml"
      });

      assert.equal(config.llm.providers.dashscope?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
      assert.deepEqual(config.llm.mainRouting.smallModelRef, ["qwen35_lan"]);
      assert.deepEqual(config.llm.mainRouting.largeModelRef, ["qwen35_lan"]);
      assert.deepEqual(config.llm.sessionCaptioner.modelRef, ["turnPlanner"]);
      assert.deepEqual(config.llm.turnPlanner.modelRef, ["qwen35_lan"]);
      assert.equal(config.llm.models.qwen35_lan, undefined);
    });
  });

  test("loadConfig ignores provider and model catalogs declared inside runtime layers", async () => {
    await withConfigDir("llm-bot-config-runtime-catalog-ignored-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeLlmCatalog(configDir, {
        providers: {
          catalogProvider: {
            baseUrl: "https://catalog.example/v1",
            apiKey: "catalog-key"
          }
        },
        models: {
          catalogMain: {
            provider: "catalogProvider",
            model: "catalog-model"
          }
        }
      });
      await writeYaml(join(configDir, "global.yml"), {
        llm: {
          enabled: true,
          mainRouting: {
            smallModelRef: "catalogMain",
            largeModelRef: "catalogMain"
          },
          providers: {
            ignoredProvider: {
              baseUrl: "https://ignored.example/v1",
              apiKey: "ignored-key"
            }
          },
          models: {
            ignoredMain: {
              provider: "ignoredProvider",
              model: "ignored-model"
            }
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.llm.providers.catalogProvider?.baseUrl, "https://catalog.example/v1");
      assert.equal(config.llm.providers.ignoredProvider, undefined);
      assert.equal(config.llm.models.catalogMain?.provider, "catalogProvider");
      assert.equal(config.llm.models.ignoredMain, undefined);
    });
  });

  test("loadConfig still supports CONFIG_INSTANCE for instance selection", async () => {
    await withConfigDir("llm-bot-config-instance-env-test", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
      await writeYaml(join(configDir, "global.yml"), {
        appName: "default-app",
        internalApi: {
          enabled: false,
          port: 3030
        }
      });
      await writeYaml(join(configDir, "instances", "acc1.yml"), {
        appName: "acc1-app",
        internalApi: {
          enabled: true,
          port: 3130
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      });

      assert.equal(config.appName, "acc1-app");
      assert.equal(config.internalApi.enabled, true);
      assert.equal(config.internalApi.port, 3130);
      assert.equal(config.configRuntime.instanceName, "acc1");
    });
  });

  test("loadConfig allows disabling webui auth independently", async () => {
    await withConfigDir("llm-bot-config-webui-auth-override-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        internalApi: {
          enabled: true,
          webui: {
            enabled: true,
            auth: {
              enabled: true
            }
          }
        }
      });
      await writeYaml(join(configDir, "instances", "default.yml"), {
        internalApi: {
          webui: {
            auth: {
              enabled: false
            }
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.internalApi.webui.enabled, true);
      assert.equal(config.internalApi.webui.auth.enabled, false);
    });
  });

  test("loadConfig keeps valid sections when a sibling section is invalid", async () => {
    await withConfigDir("llm-bot-config-partial-section-recovery", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        localFiles: {
          enabled: false,
          root: "/tmp"
        },
        browser: {
          enabled: false
        }
      });
      await writeYaml(join(configDir, "instances", "default.yml"), {
        shell: {
          enabled: true
        },
        browser: {
          enabled: "yes please"
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.shell.enabled, true);
      assert.equal(config.localFiles.root, "/tmp");
      assert.equal(config.browser.enabled, false);
    });
  });

  test("loadConfig keeps valid nested object fields when a sibling nested field is invalid", async () => {
    await withConfigDir("llm-bot-config-nested-partial-recovery", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        browser: {
          enabled: false,
          playwright: {
            enabled: false,
            proxy: false,
            headless: true
          }
        }
      });
      await writeYaml(join(configDir, "instances", "default.yml"), {
        browser: {
          enabled: true,
          playwright: {
            enabled: "not-a-boolean",
            proxy: true
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.browser.enabled, true);
      assert.equal(config.browser.playwright.proxy, true);
      assert.equal(config.browser.playwright.enabled, false);
      assert.equal(config.browser.playwright.headless, true);
    });
  });

  test("loadConfig skips a malformed instance file and keeps other valid layers", async () => {
    await withConfigDir("llm-bot-config-malformed-instance-recovery", async (configDir) => {
      await mkdir(join(configDir, "instances"), { recursive: true });
      await writeYaml(join(configDir, "global.yml"), {
        appName: "from-global",
        shell: {
          enabled: true
        }
      });
      await writeFile(
        join(configDir, "instances", "acc1.yml"),
        "appName: broken:\n  - [",
        "utf8"
      );

      const config = loadConfig({
        CONFIG_DIR: configDir,
        CONFIG_INSTANCE: "acc1"
      });

      assert.equal(config.appName, "from-global");
      assert.equal(config.shell.enabled, true);
      assert.equal(config.configRuntime.instanceName, "acc1");
    });
  });

  test("loadConfig ignores non-instance environment overrides", async () => {
    await withConfigDir("llm-bot-config-env-ignored-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        appName: "file-app",
        nodeEnv: "production",
        logLevel: "warn",
        dataDir: "file-data",
        onebot: {
          wsUrl: "ws://file.example/ws",
          httpUrl: "http://file.example/http",
          accessToken: "file-token"
        },
        llm: {
          enabled: false,
          timeoutMs: 120000
        },
        internalApi: {
          enabled: false,
          port: 3030
        },
        search: {
          googleGrounding: {
            enabled: false
          }
        },
        browser: {
          enabled: false
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir,
        BOT_NAME: "env-app",
        NODE_ENV: "development",
        LOG_LEVEL: "debug",
        DATA_DIR: "env-data",
        ONEBOT_WS_URL: "ws://env.example/ws",
        ONEBOT_HTTP_URL: "http://env.example/http",
        ONEBOT_ACCESS_TOKEN: "env-token",
        LLM_ENABLED: "true",
        INTERNAL_API_PORT: "3130",
        SEARCH_PROVIDER: "google_grounding"
      });

      assert.equal(config.appName, "file-app");
      assert.equal(config.nodeEnv, "production");
      assert.equal(config.logLevel, "warn");
      assert.equal(config.dataDir, "file-data");
      assert.equal(config.onebot.wsUrl, "ws://file.example/ws");
      assert.equal(config.onebot.httpUrl, "http://file.example/http");
      assert.equal(config.onebot.accessToken, "file-token");
      assert.equal(config.onebot.provider, "generic");
      assert.equal(config.llm.enabled, false);
      assert.equal(config.internalApi.port, 3030);
      assert.equal(config.search.googleGrounding.enabled, false);
    });
  });

  test("loadConfig reads OneBot typing provider overrides from files", async () => {
    await withConfigDir("llm-bot-config-onebot-typing-overrides-test", async (configDir) => {
      await writeDefaultInstanceYaml(configDir);
      await writeYaml(join(configDir, "global.yml"), {
        onebot: {
          provider: "napcat",
          typing: {
            enabled: true,
            private: false,
            group: true
          }
        }
      });

      const config = loadConfig({
        CONFIG_DIR: configDir
      });

      assert.equal(config.onebot.provider, "napcat");
      assert.equal(config.onebot.typing.enabled, true);
      assert.equal(config.onebot.typing.private, false);
      assert.equal(config.onebot.typing.group, true);
    });
  });

  test("loadConfig requires the selected instance config file", async () => {
    await withConfigDir("llm-bot-config-missing-instance-test", async (configDir) => {
      await writeYaml(join(configDir, "global.yml"), {
        appName: "runtime-app"
      });

      assert.throws(
        () => loadConfig({ CONFIG_DIR: configDir }),
        /Missing instance config file:/
      );
    });
  });

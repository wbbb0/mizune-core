import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileConfigSchema, llmProviderCatalogSchema } from "#config/configModel.ts";
import { exportSchemaMeta } from "#data/schema/composites.ts";
import { createInitialScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

  test("internal api exposes config editor schema metadata", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({ method: "GET", url: "/api/editors/config" });
      const schemaMeta = response.json().editor.schemaMeta;

      assert.equal(response.statusCode, 200);
      assert.equal(schemaMeta.kind, "object");
      assert.equal(schemaMeta.fields.appName.title, "应用名称");
      assert.equal(schemaMeta.fields.onebot.title, "OneBot");
      assert.equal(schemaMeta.fields.llm.title, "LLM");
      assert.equal(schemaMeta.fields.conversation.title, "会话");
      assert.equal(
        schemaMeta.fields.conversation.schema.fields.historyCompression.description,
        "控制会话历史在过长时如何压缩。"
      );

      const providerCatalogMeta = exportSchemaMeta(llmProviderCatalogSchema) as any;
      assert.equal(providerCatalogMeta.kind, "record");
      assert.equal(providerCatalogMeta.value.fields.features.schema.fields.thinking.title, "思考");
      assert.equal(providerCatalogMeta.value.fields.features.schema.fields.search.title, "搜索");

      const fileSchemaMeta = exportSchemaMeta(fileConfigSchema) as any;
      assert.equal(fileSchemaMeta.kind, "object");
      assert.equal(fileSchemaMeta.fields.proxy.schema.fields.http.title, "HTTP 代理");
      assert.equal(fileSchemaMeta.fields.proxy.schema.fields.https.title, "HTTPS 代理");
      assert.equal(fileSchemaMeta.fields.comfy.schema.fields.aspectRatios.schema.value.title, "宽高比");
      assert.equal(fileSchemaMeta.fields.comfy.schema.fields.aspectRatios.schema.value.fields.width.title, "宽度");
      assert.equal(fileSchemaMeta.fields.comfy.schema.fields.aspectRatios.schema.value.fields.height.title, "高度");
      assert.equal(fileSchemaMeta.fields.comfy.schema.fields.templates.schema.item.fields.parameterBindings.title, "参数绑定");
      assert.equal(
        fileSchemaMeta.fields.comfy.schema.fields.templates.schema.item.fields.parameterBindings.schema.fields.positivePromptPath.title,
        "正向提示词路径"
      );
      assert.equal(
        fileSchemaMeta.fields.comfy.schema.fields.templates.schema.item.fields.parameterBindings.schema.fields.widthPath.title,
        "宽度路径"
      );
      assert.equal(
        fileSchemaMeta.fields.comfy.schema.fields.templates.schema.item.fields.parameterBindings.schema.fields.heightPath.title,
        "高度路径"
      );
    } finally {
      await app.close();
    }
  });

  test("internal api exposes config, whitelist, requests, and scheduler jobs", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const [configSummary, editors, contextStatus, whitelist, requests, jobs] = await Promise.all([
        app.inject({ method: "GET", url: "/api/config-summary" }),
        app.inject({ method: "GET", url: "/api/editors" }),
        app.inject({ method: "GET", url: "/api/context/status" }),
        app.inject({ method: "GET", url: "/api/whitelist" }),
        app.inject({ method: "GET", url: "/api/requests" }),
        app.inject({ method: "GET", url: "/api/scheduler/jobs" })
      ]);

      assert.equal(configSummary.statusCode, 200);
      assert.equal(editors.statusCode, 200);
      assert.equal(contextStatus.statusCode, 200);
      assert.equal(configSummary.json().runtimeMode, "onebot");
      assert.equal(contextStatus.json().store.available, true);
      assert.equal(contextStatus.json().embedding.available, true);
      assert.equal(configSummary.json().access.ownerId, "10001");
      assert.deepEqual(configSummary.json().access.whitelist.users, ["10001"]);
      assert.equal(configSummary.json().onebot.enabled, true);
      assert.ok(editors.json().resources.some((resource: { key: string }) => resource.key === "config"));
      assert.ok(editors.json().resources.some((resource: { key: string }) => resource.key === "global_config"));
      assert.equal(editors.json().resources.some((resource: { key: string }) => resource.key === "users"), false);
      assert.equal(editors.json().resources.some((resource: { key: string }) => resource.key === "requests"), false);
      assert.equal(editors.json().resources.some((resource: { key: string }) => resource.key === "group_membership"), false);
      assert.equal(editors.json().resources.some((resource: { key: string }) => resource.key === "global_rules"), false);
      assert.equal(editors.json().resources.some((resource: { key: string }) => resource.key === "toolset_rules"), false);
      assert.deepEqual(whitelist.json().whitelist.users, ["10001"]);
      assert.deepEqual(requests.json().requests.groups, [{ groupId: "20002", userId: "10003" }]);
      assert.deepEqual(jobs.json().jobs, [{ id: "job-1", name: "daily" }]);
    } finally {
      await app.close();
    }
  });

  test("internal api lists and deletes context items", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/context/items?userId=10001&scope=user&sourceType=chunk&status=active"
      });

      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().total, 1);
      assert.equal(listResponse.json().items[0].itemId, "ctx_fixture_chunk_1");
      assert.equal(listResponse.json().items[0].text, "Alice 最近在评估 Orama 版用户上下文检索。");

      const editResponse = await app.inject({
        method: "PATCH",
        url: "/api/context/items/ctx_fixture_chunk_1",
        payload: {
          title: "已编辑上下文",
          text: "编辑后的上下文内容"
        }
      });
      assert.equal(editResponse.statusCode, 200);
      assert.equal(editResponse.json().item.title, "已编辑上下文");
      assert.equal(editResponse.json().item.text, "编辑后的上下文内容");

      const pinResponse = await app.inject({
        method: "PATCH",
        url: "/api/context/items/ctx_fixture_chunk_1/pinned",
        payload: { pinned: true }
      });
      assert.equal(pinResponse.statusCode, 200);
      assert.deepEqual(pinResponse.json(), { updated: true });

      const pinnedListResponse = await app.inject({
        method: "GET",
        url: "/api/context/items?userId=10001&scope=user&sourceType=chunk&status=active"
      });
      assert.equal(pinnedListResponse.statusCode, 200);
      assert.equal(pinnedListResponse.json().items[0].pinned, true);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: "/api/context/items/ctx_fixture_chunk_1"
      });
      assert.equal(deleteResponse.statusCode, 200);
      assert.deepEqual(deleteResponse.json(), { deleted: true });

      const afterDeleteResponse = await app.inject({
        method: "GET",
        url: "/api/context/items?userId=10001&status=active"
      });
      assert.equal(afterDeleteResponse.statusCode, 200);
      assert.equal(afterDeleteResponse.json().total, 0);

      const deletedResponse = await app.inject({
        method: "GET",
        url: "/api/context/items?userId=10001&status=deleted"
      });
      assert.equal(deletedResponse.statusCode, 200);
      assert.equal(deletedResponse.json().items[0].itemId, "ctx_fixture_chunk_1");
    } finally {
      await app.close();
    }
  });

  test("internal api exposes context maintenance actions", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const bulkDeleteResponse = await app.inject({
        method: "POST",
        url: "/api/context/items/bulk-delete",
        payload: {
          userId: "10001",
          sourceType: "chunk"
        }
      });
      assert.equal(bulkDeleteResponse.statusCode, 200);
      assert.equal(bulkDeleteResponse.json().deletedCount, 1);

      const exportResponse = await app.inject({
        method: "POST",
        url: "/api/context/items/export",
        payload: {
          userId: "10001"
        }
      });
      assert.equal(exportResponse.statusCode, 200);
      assert.equal(exportResponse.json().count, 1);
      assert.match(exportResponse.json().jsonl, /ctx_fixture_chunk_1/);

      const importResponse = await app.inject({
        method: "POST",
        url: "/api/context/items/import",
        payload: {
          jsonl: JSON.stringify({
            itemId: "ctx_imported",
            scope: "user",
            sourceType: "fact",
            retrievalPolicy: "always",
            status: "active",
            userId: "10001",
            text: "导入的上下文",
            sensitivity: "normal",
            createdAt: 1,
            updatedAt: 1,
            retrievedCount: 0
          })
        }
      });
      assert.equal(importResponse.statusCode, 200);
      assert.equal(importResponse.json().importedCount, 1);

      const compactResponse = await app.inject({
        method: "POST",
        url: "/api/context/maintenance/compact-user",
        payload: {
          userId: "10001",
          olderThanDays: 1
        }
      });
      assert.equal(compactResponse.statusCode, 200);
      assert.equal(compactResponse.json().compactedCount, 0);

      const clearEmbeddingsResponse = await app.inject({
        method: "POST",
        url: "/api/context/maintenance/clear-embeddings",
        payload: {
          userId: "10001"
        }
      });
      assert.equal(clearEmbeddingsResponse.statusCode, 200);
      assert.equal(clearEmbeddingsResponse.json().deletedCount, 0);

      const resetIndexResponse = await app.inject({
        method: "POST",
        url: "/api/context/maintenance/reset-index",
        payload: {
          userId: "10001"
        }
      });
      assert.equal(resetIndexResponse.statusCode, 200);
      assert.equal(resetIndexResponse.json().resetCount, 0);

      const rebuildIndexResponse = await app.inject({
        method: "POST",
        url: "/api/context/maintenance/rebuild-index",
        payload: {
          userId: "10001",
          forceReembed: true,
          embeddingBatchSize: 64
        }
      });
      assert.equal(rebuildIndexResponse.statusCode, 200);
      assert.equal(rebuildIndexResponse.json().embeddedCount, 1);
      assert.equal(rebuildIndexResponse.json().indexedCount, 1);

      const sweepResponse = await app.inject({
        method: "POST",
        url: "/api/context/maintenance/sweep-deleted",
        payload: {
          deletedBeforeDays: 1
        }
      });
      assert.equal(sweepResponse.statusCode, 200);
      assert.equal(sweepResponse.json().deletedCount, 1);
    } finally {
      await app.close();
    }
  });

  test("internal api rejects invalid context item filters and missing deletes", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const invalidFilterResponse = await app.inject({
        method: "GET",
        url: "/api/context/items?scope=bad_scope"
      });
      assert.equal(invalidFilterResponse.statusCode, 400);
      assert.match(invalidFilterResponse.json().error, /scope/);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: "/api/context/items/missing"
      });
      assert.equal(deleteResponse.statusCode, 404);
      assert.equal(deleteResponse.json().error, "Context item not found");

      const invalidPinResponse = await app.inject({
        method: "PATCH",
        url: "/api/context/items/ctx_fixture_chunk_1/pinned",
        payload: { pinned: "yes" }
      });
      assert.equal(invalidPinResponse.statusCode, 400);
      assert.equal(invalidPinResponse.json().error, "pinned boolean is required");

      const emptyBulkDeleteResponse = await app.inject({
        method: "POST",
        url: "/api/context/items/bulk-delete",
        payload: {}
      });
      assert.equal(emptyBulkDeleteResponse.statusCode, 400);
      assert.equal(emptyBulkDeleteResponse.json().error, "at least one context filter is required");
    } finally {
      await app.close();
    }
  });

  test("internal api validates send-text target selection", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/send-text",
        payload: { text: "hello" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "userId/groupId and text are required");
    } finally {
      await app.close();
    }
  });

  test("internal api validates and saves config editor values", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const { configDir, globalConfigPath, instanceConfigPath } = deps.config.configRuntime;
      await mkdir(`${configDir}/instances`, { recursive: true });
      await writeFile(globalConfigPath, [
        "appName: global-app",
        "nodeEnv: production",
        "logLevel: info",
        "onebot:",
        "  wsUrl: ws://global.example/ws"
      ].join("\n"), "utf8");
      const value = {
        appName: "saved-from-webui",
        logLevel: "silent"
      };
      const editorResponse = await app.inject({
        method: "GET",
        url: "/api/editors/config"
      });
      assert.equal(editorResponse.statusCode, 200);
      const editor = editorResponse.json().editor;
      assert.equal(editor.referenceValue.appName, "global-app");
      assert.equal(editor.referenceValue.scheduler, undefined);
      assert.equal(editor.schemaDefaultValue.scheduler.defaultTimezone, "Asia/Shanghai");
      assert.equal(editor.schemaDefaultValue.shell.terminalEvents.enabled, true);
      assert.equal(editor.schemaDefaultValue.shell.terminalEvents.inputDetectionDebounceMs, 800);
      assert.equal(editor.currentValue.appName, undefined);
      assert.equal(editor.effectiveValue.appName, "global-app");
      assert.equal(editor.effectiveValue.scheduler.defaultTimezone, "Asia/Shanghai");
      assert.equal(editor.effectiveValue.shell.terminalEvents.inputPromptCooldownMs, 30000);
      assert.equal(editor.editorFeatures.unsetMode, "reference");
      assert.equal(editor.editorFeatures.unsetActionLabel, "恢复继承");

      const validateResponse = await app.inject({
        method: "POST",
        url: "/api/editors/config/validate",
        payload: { value }
      });
      assert.equal(validateResponse.statusCode, 200);
      assert.equal(validateResponse.json().ok, true);
      assert.equal(validateResponse.json().parsed.appName, "saved-from-webui");
      assert.equal(validateResponse.json().currentValue.appName, undefined);
      assert.equal(validateResponse.json().referenceValue.appName, "global-app");
      assert.equal(validateResponse.json().effective.onebot.wsUrl, "ws://global.example/ws");

      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/editors/config/save",
        payload: {
          value
        }
      });
      assert.equal(saveResponse.statusCode, 200);
      assert.equal(saveResponse.json().path, instanceConfigPath);
      assert.equal(deps.__state.configCheckForUpdatesCount, 1);
      const saved = await readFile(instanceConfigPath, "utf8");
      assert.match(saved, /appName: saved-from-webui/);
      assert.doesNotMatch(saved, /onebot:/);
      assert.doesNotMatch(saved, /nodeEnv: production/);
    } finally {
      await app.close();
    }
  });

  test("internal api normalizes global config with defaults and strips unknown keys", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const { configDir, globalConfigPath, instanceConfigPath } = deps.config.configRuntime;
      await mkdir(`${configDir}/instances`, { recursive: true });
      await writeFile(instanceConfigPath, [
        "appName: instance-app",
        "logLevel: debug"
      ].join("\n"), "utf8");
      await writeFile(globalConfigPath, [
        "appName: global-app",
        "obsoleteKey: remove-me",
        "onebot:",
        "  wsUrl: ws://global.example/ws"
      ].join("\n"), "utf8");

      const editorResponse = await app.inject({
        method: "GET",
        url: "/api/editors/global_config"
      });
      assert.equal(editorResponse.statusCode, 200);
      const editor = editorResponse.json().editor;
      assert.equal(editor.kind, "single");
      assert.equal(editor.file.path, globalConfigPath);
      assert.equal(editor.currentValue.appName, "global-app");
      assert.equal(editor.currentValue.obsoleteKey, undefined);
      assert.equal(editor.currentValue.scheduler.defaultTimezone, "Asia/Shanghai");
      assert.equal(editor.currentValue.onebot.wsUrl, "ws://global.example/ws");
      assert.equal(editor.currentValue.comfy.enabled, false);

      const normalizeResponse = await app.inject({
        method: "POST",
        url: "/api/editors/global_config/normalize",
        payload: {
          value: editor.currentValue
        }
      });
      assert.equal(normalizeResponse.statusCode, 200);
      assert.equal(normalizeResponse.json().path, globalConfigPath);
      assert.equal(normalizeResponse.json().parsed.appName, "global-app");
      assert.equal(normalizeResponse.json().parsed.scheduler.defaultTimezone, "Asia/Shanghai");
      assert.equal(deps.__state.configCheckForUpdatesCount, 1);

      const savedGlobal = await readFile(globalConfigPath, "utf8");
      const savedInstance = await readFile(instanceConfigPath, "utf8");
      assert.match(savedGlobal, /appName: global-app/);
      assert.match(savedGlobal, /scheduler:/);
      assert.match(savedGlobal, /defaultTimezone: Asia\/Shanghai/);
      assert.match(savedGlobal, /comfy:/);
      assert.doesNotMatch(savedGlobal, /obsoleteKey/);
      assert.match(savedInstance, /appName: instance-app/);
      assert.doesNotMatch(savedGlobal, /instance-app/);
    } finally {
      await app.close();
    }
  });

  test("internal api only allows normalization for global config editor", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/editors/llm_provider_catalog/normalize",
        payload: {
          value: {}
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "Editor resource cannot be normalized: llm_provider_catalog");
    } finally {
      await app.close();
    }
  });

  test("internal api exposes live_resources through data registry", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      await mkdir(deps.config.dataDir, { recursive: true });
      const resourcesResponse = await app.inject({
        method: "GET",
        url: "/api/data/registry/resources"
      });
      const liveResourcesRowsResponse = await app.inject({
        method: "GET",
        url: "/api/data/registry/resources/live_resources/rows"
      });

      assert.equal(resourcesResponse.statusCode, 200);
      assert.equal(resourcesResponse.json().resources.some((resource: { key: string }) => resource.key === "live_resources"), true);
      assert.equal(liveResourcesRowsResponse.statusCode, 200);
      assert.deepEqual(liveResourcesRowsResponse.json().rows, []);
    } finally {
      await app.close();
    }
  });

  test("internal api auto-completes default routing preset template on load and save", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const catalogPath = deps.config.configRuntime.llmRoutingPresetCatalogPath;
      await writeFile(catalogPath, [
        "dev:",
        "  mainSmall:",
        "    - main"
      ].join("\n"), "utf8");

      const editorResponse = await app.inject({
        method: "GET",
        url: "/api/editors/llm_routing_preset_catalog"
      });
      assert.equal(editorResponse.statusCode, 200);
      assert.equal(editorResponse.json().editor.editorFeatures.unsetMode, "reference");
      assert.deepEqual(editorResponse.json().editor.template, {
        default: {
          mainSmall: [],
          mainLarge: [],
          summarizer: [],
          textInspector: [],
          sessionCaptioner: [],
          imageCaptioner: [],
          imageInspector: [],
          audioTranscription: [],
          turnPlanner: [],
          embedding: [],
          historyWindow: {
            maxRecentMessages: 50,
            maxImageReferences: 5
          },
          tokenLimits: {
            triggerTokens: 150000,
            retainTokens: 4000
          }
        }
      });
      assert.equal(editorResponse.json().editor.editorFeatures.unsetActionLabel, "回退到 default");
      assert.deepEqual(editorResponse.json().editor.currentValue.default, {
        mainSmall: [],
        mainLarge: [],
        summarizer: [],
        textInspector: [],
        sessionCaptioner: [],
        imageCaptioner: [],
        imageInspector: [],
        audioTranscription: [],
        turnPlanner: [],
        embedding: [],
        historyWindow: {
          maxRecentMessages: 50,
          maxImageReferences: 5
        },
        tokenLimits: {
          triggerTokens: 150000,
          retainTokens: 4000
        }
      });
      assert.deepEqual(editorResponse.json().editor.currentValue.dev, {
        mainSmall: ["main"]
      });
      assert.deepEqual(editorResponse.json().editor.referenceValue.dev, {
        mainSmall: [],
        mainLarge: [],
        summarizer: [],
        textInspector: [],
        sessionCaptioner: [],
        imageCaptioner: [],
        imageInspector: [],
        audioTranscription: [],
        turnPlanner: [],
        embedding: [],
        historyWindow: {
          maxRecentMessages: 50,
          maxImageReferences: 5
        },
        tokenLimits: {
          triggerTokens: 150000,
          retainTokens: 4000
        }
      });
      assert.deepEqual(editorResponse.json().editor.effectiveValue.dev, {
        mainSmall: ["main"],
        mainLarge: [],
        summarizer: [],
        textInspector: [],
        sessionCaptioner: [],
        imageCaptioner: [],
        imageInspector: [],
        audioTranscription: [],
        turnPlanner: [],
        embedding: [],
        historyWindow: {
          maxRecentMessages: 50,
          maxImageReferences: 5
        },
        tokenLimits: {
          triggerTokens: 150000,
          retainTokens: 4000
        }
      });

      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/editors/llm_routing_preset_catalog/save",
        payload: {
          value: {
            dev: {
              mainSmall: ["main"],
              summarizer: []
            }
          }
        }
      });
      assert.equal(saveResponse.statusCode, 200);
      assert.deepEqual(saveResponse.json().parsed.default, {
        mainSmall: [],
        mainLarge: [],
        summarizer: [],
        textInspector: [],
        sessionCaptioner: [],
        imageCaptioner: [],
        imageInspector: [],
        audioTranscription: [],
        turnPlanner: [],
        embedding: [],
        historyWindow: {
          maxRecentMessages: 50,
          maxImageReferences: 5
        },
        tokenLimits: {
          triggerTokens: 150000,
          retainTokens: 4000
        }
      });
      const saved = await readFile(catalogPath, "utf8");
      assert.match(saved, /default:/);
      assert.match(saved, /historyWindow:/);
      assert.match(saved, /tokenLimits:/);
      assert.match(saved, /mainLarge: \[\]/);
      assert.match(saved, /summarizer: \[\]/);
      assert.match(saved, /textInspector: \[\]/);
    } finally {
      await app.close();
    }
  });

  test("internal api routing preset editor keeps missing fields effective via default fallback", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const catalogPath = deps.config.configRuntime.llmRoutingPresetCatalogPath;
      await writeFile(catalogPath, [
        "default:",
        "  mainSmall:",
        "    - fallback-main",
        "  summarizer:",
        "    - fallback-summary",
        "dev:",
        "  mainSmall:",
        "    - dev-main"
      ].join("\n"), "utf8");

      const response = await app.inject({
        method: "GET",
        url: "/api/editors/llm_routing_preset_catalog"
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().editor.referenceValue.dev.summarizer, ["fallback-summary"]);
      assert.deepEqual(response.json().editor.effectiveValue.dev.summarizer, ["fallback-summary"]);
      assert.deepEqual(response.json().editor.effectiveValue.dev.mainSmall, ["dev-main"]);
    } finally {
      await app.close();
    }
  });

  test("internal api returns not found for unknown shell session", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/shell/sessions/missing"
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "Shell session not found");
    } finally {
      await app.close();
    }
  });

  test("internal api exposes session detail", async () => {
    const deps = createInternalApiDeps();
    deps.__state.sessions[0]?.internalTranscript.push({
      kind: "user_message",
      role: "user",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: '看这个 image_id="file_image_1" audio_id="aud_fixture_1"',
      imageIds: ["file_image_1"],
      emojiIds: [],
      attachments: [],
      messageFiles: [],
      audioCount: 1,
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      mentionedSelf: false,
      timestampMs: 1
    });
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/qqbot:p:10001"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().session.id, "qqbot:p:10001");
      assert.equal(response.json().session.modeId, "rp_assistant");
      assert.equal(response.json().session.title, "Alice");
      assert.equal(response.json().session.titleSource, "manual");
      assert.equal(response.json().session.titleGenerationAvailable, false);
      assert.ok(response.json().session.derivedObservations.some((item: { purpose: string }) => item.purpose === "session_title"));
      assert.ok(response.json().session.derivedObservations.some((item: { purpose: string }) => item.purpose === "history_summary"));
      assert.ok(response.json().session.derivedObservations.some((item: { purpose: string; sourceId: string }) => item.purpose === "image_caption" && item.sourceId === "file_image_1"));
      assert.ok(response.json().session.derivedObservations.some((item: { purpose: string; sourceId: string }) => item.purpose === "audio_transcription" && item.sourceId === "aud_fixture_1"));
      assert.deepEqual(response.json().session.participantRef, {
        kind: "user",
        id: "10001"
      });
      assert.ok(!("participantLabel" in response.json().session));
      assert.equal(response.json().session.historyRevision, 0);
      assert.equal(response.json().modeState, null);
    } finally {
      await app.close();
    }
  });

  test("internal api exposes scenario_host mode state in session detail", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/qqbot:p:10001"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().modeState.kind, "scenario_host");
      assert.equal(response.json().modeState.state.player.userId, "10001");
      assert.ok(!("title" in response.json().modeState.state));
    } finally {
      await app.close();
    }
  });

  test("internal api snapshots and restores scenario_host sessions", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const initialDetailResponse = await app.inject({
        method: "GET",
        url: "/api/sessions/qqbot:p:10001"
      });
      assert.equal(initialDetailResponse.statusCode, 200);
      const initialState = initialDetailResponse.json().modeState.state;
      const saveStateResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            ...initialState,
            profile: {
              ...initialState.profile,
              theme: "快照前主题"
            },
            currentSituation: "快照前局面"
          }
        }
      });
      assert.equal(saveStateResponse.statusCode, 200);

      const snapshotResponse = await app.inject({
        method: "POST",
        url: "/api/sessions/qqbot:p:10001/snapshots",
        payload: {
          label: "回到旧港"
        }
      });
      assert.equal(snapshotResponse.statusCode, 200);
      assert.equal(snapshotResponse.json().snapshot.label, "回到旧港");
      assert.equal(snapshotResponse.json().snapshot.hasScenarioHostState, true);
      const snapshotId = snapshotResponse.json().snapshot.id;

      const mutateStateResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            ...saveStateResponse.json().modeState.state,
            profile: {
              ...saveStateResponse.json().modeState.state.profile,
              theme: "快照后主题"
            },
            currentSituation: "快照后局面"
          }
        }
      });
      assert.equal(mutateStateResponse.statusCode, 200);
      assert.equal(mutateStateResponse.json().modeState.state.currentSituation, "快照后局面");

      const restoreResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/qqbot:p:10001/snapshots/${snapshotId}/restore`
      });
      assert.equal(restoreResponse.statusCode, 200);
      assert.equal(restoreResponse.json().session.modeId, "scenario_host");
      assert.equal(restoreResponse.json().modeState.state.profile.theme, "快照前主题");
      assert.equal(restoreResponse.json().modeState.state.currentSituation, "快照前局面");

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/sessions/qqbot:p:10001/snapshots"
      });
      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().snapshots.length, 1);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/qqbot:p:10001/snapshots/${snapshotId}`
      });
      assert.equal(deleteResponse.statusCode, 200);
      assert.equal(deleteResponse.json().ok, true);
      assert.equal(deps.__state.sessionSnapshots.length, 0);
    } finally {
      await app.close();
    }
  });

  test("internal api rejects snapshot create and restore while session is delivering", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const snapshotResponse = await app.inject({
        method: "POST",
        url: "/api/sessions/qqbot:p:10001/snapshots",
        payload: { label: "发送前" }
      });
      assert.equal(snapshotResponse.statusCode, 200);
      const snapshotId = snapshotResponse.json().snapshot.id;
      deps.__state.sessions[0]!.phase = { kind: "delivering" };

      const createWhileDeliveringResponse = await app.inject({
        method: "POST",
        url: "/api/sessions/qqbot:p:10001/snapshots",
        payload: { label: "发送中" }
      });
      assert.equal(createWhileDeliveringResponse.statusCode, 400);
      assert.match(createWhileDeliveringResponse.json().error, /正在回复/);

      const restoreWhileDeliveringResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/qqbot:p:10001/snapshots/${snapshotId}/restore`
      });
      assert.equal(restoreWhileDeliveringResponse.statusCode, 400);
      assert.match(restoreWhileDeliveringResponse.json().error, /正在回复/);

      const copyWhileDeliveringResponse = await app.inject({
        method: "POST",
        url: "/api/sessions/qqbot:p:10001/copy"
      });
      assert.equal(copyWhileDeliveringResponse.statusCode, 400);
      assert.match(copyWhileDeliveringResponse.json().error, /正在回复/);
    } finally {
      await app.close();
    }
  });

  test("internal api copies any session to a new web session with scenario state", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const detailResponse = await app.inject({
        method: "GET",
        url: "/api/sessions/qqbot:p:10001"
      });
      assert.equal(detailResponse.statusCode, 200);
      const state = detailResponse.json().modeState.state;
      const updateResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            ...state,
            profile: {
              ...state.profile,
              theme: "复制前主题"
            },
            currentSituation: "复制前局面"
          }
        }
      });
      assert.equal(updateResponse.statusCode, 200);
      deps.__state.sessions[0]!.operationMode = { kind: "persona_config", draft: {} } as never;
      deps.__state.sessions[0]!.taskTracker = {
        version: 1,
        primary: {
          taskId: "task-copy-source",
          status: "active",
          objective: "源会话任务",
          done: [],
          next: ["继续源会话"],
          blockers: [],
          importantToolRefs: [],
          createdAtMs: 1,
          updatedAtMs: 2
        },
        parked: [],
        evidence: []
      };
      deps.__state.sessions[0]!.debugMarkers = [{ kind: "debug_enabled", timestampMs: 3 }];
      deps.__state.sessions[0]!.pacingPreferences = {
        inputDebounce: { mode: "fixed", delayMs: 3_500 },
        oneBotOutbound: "immediate"
      };
      deps.__state.sessions[0]!.lastLlmUsage = {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        cachedTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        providerReported: true,
        modelRef: "fixture",
        model: "fixture",
        capturedAt: 4
      };

      const copyResponse = await app.inject({
        method: "POST",
        url: "/api/sessions/qqbot:p:10001/copy",
        payload: {
          title: "Web 副本"
        }
      });
      assert.equal(copyResponse.statusCode, 200);
      assert.equal(copyResponse.json().session.source, "web");
      assert.equal(copyResponse.json().session.type, "private");
      assert.deepEqual(copyResponse.json().session.participantRef, { kind: "user", id: "10001" });
      assert.equal(copyResponse.json().session.title, "Web 副本");
      assert.equal(copyResponse.json().session.modeId, "scenario_host");
      const copiedSessionId = copyResponse.json().session.id;
      assert.match(copiedSessionId, /^web:/);
      assert.equal(copyResponse.json().modeState.state.profile.theme, "复制前主题");
      assert.equal(copyResponse.json().modeState.state.currentSituation, "复制前局面");
      assert.equal(deps.__state.scenarioHostStates[copiedSessionId]?.profile.theme, "复制前主题");
      const copiedRuntimeSession = deps.__state.sessions.find((session) => session.id === copiedSessionId);
      assert.equal(copiedRuntimeSession?.operationMode.kind, "normal");
      assert.equal(copiedRuntimeSession?.taskTracker.primary, null);
      assert.deepEqual(copiedRuntimeSession?.debugMarkers, []);
      assert.equal(copiedRuntimeSession?.lastLlmUsage, null);
      assert.deepEqual(copiedRuntimeSession?.pacingPreferences, {
        inputDebounce: { mode: "fixed", delayMs: 3_500 },
        oneBotOutbound: "immediate"
      });

      const copiedDetailResponse = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(copiedSessionId)}`
      });
      assert.equal(copiedDetailResponse.statusCode, 200);
      assert.equal(copiedDetailResponse.json().session.source, "web");
      assert.deepEqual(copiedDetailResponse.json().session.participantRef, { kind: "user", id: "10001" });
      assert.deepEqual(copiedDetailResponse.json().session.pacingPreferences, {
        inputDebounce: { mode: "fixed", delayMs: 3_500 },
        oneBotOutbound: "immediate"
      });
      assert.equal(copiedDetailResponse.json().modeState.state.profile.theme, "复制前主题");
    } finally {
      await app.close();
    }
  });

  test("internal api remaps copied group scenario state to the new web participant", async () => {
    const deps = createInternalApiDeps();
    deps.__state.sessions.push({
      id: "qqbot:g:20001",
      type: "group",
      source: "onebot",
      modeId: "scenario_host",
      operationMode: { kind: "normal" },
      participantRef: { kind: "group", id: "20001" },
      participantUserId: "20001",
      participantLabel: "Group 20001",
      title: "Group 20001",
      titleSource: "manual",
      phase: { kind: "idle" },
      pendingMessages: [],
      taskTracker: { version: 1, primary: null, parked: [], evidence: [] },
      internalTranscript: [],
      debugMarkers: [],
      lastLlmUsage: null,
      isGenerating: false,
      lastActiveAt: 123456
    });
    deps.__state.scenarioHostStates["qqbot:g:20001"] = createInitialScenarioHostSessionState({
      playerUserId: "20001",
      playerDisplayName: "20001"
    });
    deps.__state.scenarioHostStates["qqbot:g:20001"]!.player.heldItems = [
      { name: "玩家旧钥匙", description: "旧群会话里玩家随身携带的钥匙", quantity: 1 }
    ];
    deps.__state.scenarioHostStates["qqbot:g:20001"]!.entities.push({
      id: "keeper-ledger",
      kind: "item",
      name: "守门人账本",
      aliases: [],
      summary: "守门人随身记录出入账目的旧账本。",
      status: "",
      locationId: null,
      tags: [],
      notes: ""
    });
    const app = await createInternalApiApp(deps);
    try {
      const copyResponse = await app.inject({
        method: "POST",
        url: "/api/sessions/qqbot:g:20001/copy",
        payload: {
          title: "群副本"
        }
      });
      assert.equal(copyResponse.statusCode, 200);
      assert.deepEqual(copyResponse.json().session.participantRef, { kind: "user", id: "owner" });
      assert.equal(copyResponse.json().modeState.state.player.userId, "owner");
      assert.equal(copyResponse.json().modeState.state.player.displayName, "群副本");
      assert.deepEqual(copyResponse.json().modeState.state.player.heldItems, [
        { name: "玩家旧钥匙", description: "旧群会话里玩家随身携带的钥匙", quantity: 1 }
      ]);
      assert.equal(copyResponse.json().modeState.state.entities.find((item: any) => item.id === "keeper-ledger")?.name, "守门人账本");
      const copiedSessionId = copyResponse.json().session.id;
      assert.equal(deps.__state.scenarioHostStates[copiedSessionId]?.player.userId, "owner");
      assert.equal(deps.__state.scenarioHostStates[copiedSessionId]?.player.heldItems[0]?.name, "玩家旧钥匙");
    } finally {
      await app.close();
    }
  });

  test("internal api updates scenario_host mode state", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const updateResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            version: 5,
            profile: {
              theme: "旧港钟声",
              worldBaseline: "旧港每晚零点都会响钟。",
              narrationStyle: "冷静克制",
              boundaries: ""
            },
            currentSituation: "码头上空有钟声回荡。",
            currentLocation: "旧港码头",
            sceneSummary: "玩家刚抵达旧港。",
            player: {
              userId: "10001",
              displayName: "Alice",
              basicInfo: "旧港调查员，受托追查午夜钟声。",
              characterDescription: "谨慎、善于观察，习惯先确认环境再行动。",
              wornItems: [{ name: "油布外套", wearPosition: "外套", description: "能挡住码头夜风" }],
              heldItems: [{ name: "铜钥匙", description: "刚从码头旧箱里找到", quantity: 1 }],
              statusDescription: ""
            },
            objectives: [{ id: "find-bell", title: "找到钟楼", status: "active", summary: "先去高处确认钟声来源" }],
            loreEntries: [{
              id: "old-port-bell",
              title: "旧港钟声",
              content: "旧港每晚零点都会响钟。",
              tags: [],
              activationKeys: [],
              enabled: true,
              priority: 100,
              createdAtTurn: 0,
              updatedAtTurn: 3
            }],
            npcs: [],
            entities: [],
            relations: [],
            journal: [],
            mechanics: { ruleStyle: "freeform", dicePolicy: "", difficultyScale: "", successStates: [] },
            flags: { alerted: true, suspicion: 2 },
            initialized: true,
            turnIndex: 3
          }
        }
      });

      assert.equal(updateResponse.statusCode, 200);
      assert.equal(updateResponse.json().modeState.kind, "scenario_host");
      assert.ok(!("title" in updateResponse.json().modeState.state));
      assert.equal(updateResponse.json().modeState.state.initialized, true);
      assert.equal(updateResponse.json().modeState.state.profile.theme, "旧港钟声");
      assert.deepEqual(updateResponse.json().modeState.state.player.heldItems, [{ name: "铜钥匙", description: "刚从码头旧箱里找到", quantity: 1 }]);

      const stateWithoutProfile = { ...updateResponse.json().modeState.state };
      delete stateWithoutProfile.profile;
      const updateWithoutProfileResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            ...stateWithoutProfile,
            currentSituation: "钟声变得更近。"
          }
        }
      });
      assert.equal(updateWithoutProfileResponse.statusCode, 200);
      assert.equal(updateWithoutProfileResponse.json().modeState.state.profile.theme, "旧港钟声");

      const openedState = updateWithoutProfileResponse.json().modeState.state;
      const backgroundUpdateResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            ...openedState,
            currentSituation: "后台工具已经推进到钟楼门前。",
            entities: [
              ...openedState.entities,
              {
                id: "background-silver-key",
                kind: "item",
                name: "银钥匙",
                aliases: [],
                summary: "后台追加的场景道具不应丢失。",
                status: "",
                locationId: null,
                tags: [],
                notes: ""
              }
            ],
            objectives: [
              ...openedState.objectives,
              { id: "background-objective", title: "后台目标", status: "active", summary: "后台追加的目标不应丢失" }
            ],
            loreEntries: [
              ...openedState.loreEntries,
              {
                id: "background-lore",
                title: "后台新增",
                content: "后台追加的 lore 不应丢失。",
                tags: [],
                activationKeys: [],
                enabled: true,
                priority: 100,
                createdAtTurn: 3,
                updatedAtTurn: 3
              }
            ]
          }
        }
      });
      assert.equal(backgroundUpdateResponse.statusCode, 200);

      const mergeResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          baseState: openedState,
          state: {
            ...openedState,
            profile: {
              ...openedState.profile,
              boundaries: "不写血腥细节"
            },
            loreEntries: openedState.loreEntries.map((entry: any) => entry.id === "old-port-bell"
              ? { ...entry, priority: 140 }
              : entry),
            player: {
              ...openedState.player,
              heldItems: openedState.player.heldItems.map((entry: any) => entry.name === "铜钥匙"
                ? { ...entry, quantity: 2 }
                : entry)
            },
            objectives: openedState.objectives.map((entry: any) => entry.id === "find-bell"
              ? { ...entry, summary: "前往高处确认钟声来源" }
              : entry)
          }
        }
      });
      assert.equal(mergeResponse.statusCode, 200);
      assert.equal(mergeResponse.json().modeState.state.currentSituation, "后台工具已经推进到钟楼门前。");
      assert.equal(mergeResponse.json().modeState.state.profile.boundaries, "不写血腥细节");
      assert.equal(mergeResponse.json().modeState.state.loreEntries.find((entry: any) => entry.id === "old-port-bell").priority, 140);
      assert.equal(mergeResponse.json().modeState.state.loreEntries.find((entry: any) => entry.id === "background-lore").content, "后台追加的 lore 不应丢失。");
      assert.equal(mergeResponse.json().modeState.state.player.heldItems.find((entry: any) => entry.name === "铜钥匙").quantity, 2);
      assert.equal(mergeResponse.json().modeState.state.entities.find((entry: any) => entry.id === "background-silver-key").name, "银钥匙");
      assert.equal(mergeResponse.json().modeState.state.objectives.find((entry: any) => entry.id === "find-bell").summary, "前往高处确认钟声来源");
      assert.equal(mergeResponse.json().modeState.state.objectives.find((entry: any) => entry.id === "background-objective").summary, "后台追加的目标不应丢失");

      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/qqbot:p:10001"
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().modeState.state.currentLocation, "旧港码头");
      assert.equal(response.json().modeState.state.turnIndex, 3);
    } finally {
      await app.close();
    }
  });

  test("internal api rejects mode state updates for non-scenario sessions", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            version: 1
          }
        }
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /scenario_host/i);
    } finally {
      await app.close();
    }
  });

  test("internal api rejects invalid scenario_host mode state payloads", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const response = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            version: 5,
            title: "坏数据"
          }
        }
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /player|title|unknown key/i);
    } finally {
      await app.close();
    }
  });

  test("internal api rejects initialized scenario_host state with missing player runtime fields", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const response = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode-state",
        payload: {
          state: {
            version: 5,
            profile: {
              theme: "旧港钟声",
              worldBaseline: "旧港每晚零点都会响钟。",
              narrationStyle: "冷静克制",
              boundaries: ""
            },
            currentSituation: "码头上空有钟声回荡。",
            currentLocation: "旧港码头",
            sceneSummary: "",
            player: {
              userId: "10001",
              displayName: "Alice",
              basicInfo: "",
              characterDescription: "",
              wornItems: [],
              heldItems: [],
              statusDescription: ""
            },
            objectives: [],
            loreEntries: [],
            npcs: [],
            entities: [],
            relations: [],
            journal: [],
            mechanics: { ruleStyle: "freeform", dicePolicy: "", difficultyScale: "", successStates: [] },
            flags: {},
            initialized: true,
            turnIndex: 0
          }
        }
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /scenario_initialized_state_invalid|玩家基础信息|玩家角色描述|玩家穿着|玩家持有物/);
    } finally {
      await app.close();
    }
  });

  test("internal api exposes session modes and allows switching a session mode", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const modesResponse = await app.inject({
        method: "GET",
        url: "/api/session-modes"
      });
      assert.equal(modesResponse.statusCode, 200);
      assert.deepEqual(modesResponse.json().modes, [{
        id: "rp_assistant",
        title: "RP Assistant",
        description: "当前默认模式。保留现有角色扮演 + 助手能力。",
        allowedChatTypes: ["private", "group"]
      }, {
        id: "assistant",
        title: "Assistant",
        description: "普通助手模式。使用全局 persona 作为人格底座，但不读取长期记忆、用户资料或模式专属资料。",
        allowedChatTypes: ["private", "group"]
      }, {
        id: "scenario_host",
        title: "Scenario Host",
        description: "轻规则单人剧情主持模式。当前仅支持私聊。",
        allowedChatTypes: ["private"]
      }]);

      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:p:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);
      assert.equal(switchResponse.json().session.modeId, "scenario_host");
    } finally {
      await app.close();
    }
  });

  test("internal api rejects scenario_host for group sessions", async () => {
    const deps = createInternalApiDeps();
    deps.__state.sessions.push({
      id: "qqbot:g:20001",
      type: "group",
      source: "onebot",
      modeId: "rp_assistant",
      participantRef: { kind: "group", id: "20001" },
      participantUserId: "20001",
      participantLabel: "Group 20001",
      title: "Group 20001",
      titleSource: "manual",
      operationMode: { kind: "normal" },
      phase: { kind: "idle" },
      pendingMessages: [],
      taskTracker: { version: 1, primary: null, parked: [], evidence: [] },
      internalTranscript: [],
      debugMarkers: [],
      lastLlmUsage: null,
      isGenerating: false,
      lastActiveAt: 123456
    });
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/qqbot:g:20001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 400);
      assert.match(switchResponse.json().error, /does not support group chat/);
    } finally {
      await app.close();
    }
  });

  test("internal api exposes workspace listing, text preview, workspace image content, and stored file content", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const [listResponse, statResponse, fileResponse, imageContentResponse, sendContentResponse, filesResponse, storedFileResponse, contentResponse] = await Promise.all([
        app.inject({ method: "GET", url: "/api/local-files/items" }),
        app.inject({ method: "GET", url: "/api/local-files/stat?path=notes.txt" }),
        app.inject({ method: "GET", url: "/api/local-files/file?path=notes.txt&startLine=1&endLine=2" }),
        app.inject({ method: "GET", url: "/api/local-files/content?path=photo.png" }),
        app.inject({ method: "GET", url: "/api/local-files/send-content?path=photo.png" }),
        app.inject({ method: "GET", url: "/api/chat-files" }),
        app.inject({ method: "GET", url: "/api/chat-files/file_image_1" }),
        app.inject({ method: "GET", url: "/api/chat-files/file_image_1/content" })
      ]);

      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().items[0].path, "docs");
      assert.equal(statResponse.statusCode, 200);
      assert.equal(statResponse.json().path, "notes.txt");
      assert.equal(fileResponse.statusCode, 200);
      assert.equal(fileResponse.json().content, "line 1\nline 2");
      assert.equal(fileResponse.json().truncated, true);
      assert.equal(imageContentResponse.statusCode, 200);
      assert.equal(imageContentResponse.headers["content-type"], "image/png");
      assert.ok(imageContentResponse.body.length > 0);
      assert.equal(sendContentResponse.statusCode, 200);
      assert.equal(sendContentResponse.headers["content-type"], "image/png");
      assert.ok(sendContentResponse.body.length > 0);
      assert.equal(filesResponse.statusCode, 200);
      assert.equal(filesResponse.json().files[0].fileId, "file_image_1");
      assert.equal(filesResponse.json().files[0].captionObservation.purpose, "image_caption");
      assert.equal(storedFileResponse.statusCode, 200);
      assert.equal(storedFileResponse.json().file.sourceName, "fixture.png");
      assert.equal(storedFileResponse.json().file.captionStatus, "missing");
      assert.equal(contentResponse.statusCode, 200);
      assert.equal(contentResponse.headers["content-type"], "image/png");
      assert.ok(contentResponse.body.length > 0);
    } finally {
      await app.close();
    }
  });

  test("internal api rejects workspace path escape and returns not found for missing stored file", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const badPathResponse = await app.inject({
        method: "GET",
        url: "/api/local-files/items?path=../escape"
      });
      assert.equal(badPathResponse.statusCode, 400);

      const missingFileResponse = await app.inject({
        method: "GET",
        url: "/api/chat-files/missing_file"
      });
      assert.equal(missingFileResponse.statusCode, 404);
      assert.equal(missingFileResponse.json().error, "Chat file not found");
    } finally {
      await app.close();
    }
  });

  test("internal api rejects binary workspace files in text preview", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/local-files/file?path=photo.png"
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "Workspace file is not a text file: photo.png");
    } finally {
      await app.close();
    }
  });

  test("internal api shell routes expose success payloads", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const [listResponse, getResponse, runResponse, interactResponse, readResponse, signalResponse, resizeResponse, closeResponse] = await Promise.all([
        app.inject({ method: "GET", url: "/api/shell/sessions" }),
        app.inject({ method: "GET", url: "/api/shell/sessions/shell-1" }),
        app.inject({ method: "POST", url: "/api/shell/run", payload: { command: "pwd", description: "test shell", cwd: "/tmp", tty: true, background: true } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/interact", payload: { input: "ls\n" } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/read" }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/signal", payload: { signal: "SIGTERM" } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/resize", payload: { cols: 100, rows: 24 } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/close" })
      ]);

      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().sessions[0].id, "shell-1");
      assert.equal(getResponse.statusCode, 200);
      assert.equal(getResponse.json().session.id, "shell-1");
      assert.equal(runResponse.statusCode, 200);
      assert.equal(runResponse.json().result.command, "pwd");
      assert.equal(interactResponse.json().output, "ls\n");
      assert.equal(readResponse.json().output, "pwd\n");
      assert.equal(signalResponse.json().session.signal, "SIGTERM");
      assert.equal(resizeResponse.json().session.command, "resize 100x24");
      assert.deepEqual(closeResponse.json(), { ok: true });
      assert.deepEqual(deps.__state.closedSessionIds, ["shell-1"]);
    } finally {
      await app.close();
    }
  });

  test("internal api send-text sends to selected target", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/send-text",
        payload: { userId: "10001", text: "hello" }
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(deps.__state.sentMessages, [{ userId: "10001", text: "hello" }]);
    } finally {
      await app.close();
    }
  });

  test("internal api rejects send-text when onebot is disabled", async () => {
    const deps = createInternalApiDeps();
    deps.config.onebot.enabled = false;
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/send-text",
        payload: { userId: "10001", text: "hello" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "OneBot is disabled in the current runtime mode");
    } finally {
      await app.close();
    }
  });

  test("config summary switches to webui-only semantics when onebot is disabled", async () => {
    const deps = createInternalApiDeps();
    deps.config.onebot.enabled = false;
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/config-summary"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().runtimeMode, "webui_only");
      assert.equal(response.json().access.ownerId, null);
      assert.deepEqual(response.json().access.whitelist, {
        enabled: false,
        users: [],
        groups: []
      });
    } finally {
      await app.close();
    }
  });

  test("internal api creates web sessions with default title and participantRef", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { modeId: "rp_assistant" }
      });

      assert.equal(createResponse.statusCode, 200);
      assert.equal(createResponse.json().session.source, "web");
      assert.equal(createResponse.json().session.title, "New Chat");
      assert.equal(createResponse.json().session.titleSource, "default");
      assert.deepEqual(createResponse.json().session.participantRef, {
        kind: "user",
        id: "owner"
      });
      assert.ok(!("participantLabel" in createResponse.json().session));
      assert.ok(!("participantUserId" in createResponse.json().session));

      const sessionId = createResponse.json().session.id;
      const snapshotResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/snapshots`,
        payload: { label: "删除前存档" }
      });
      assert.equal(snapshotResponse.statusCode, 200);
      assert.equal(deps.__state.sessionSnapshots.length, 1);

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/sessions"
      });
      assert.equal(listResponse.statusCode, 200);
      const createdSession = listResponse.json().sessions.find((item: { id: string }) => item.id === sessionId);
      assert.ok(createdSession);
      assert.equal(createdSession.title, "New Chat");
      assert.equal(createdSession.titleSource, "default");
      assert.deepEqual(createdSession.participantRef, {
        kind: "user",
        id: "owner"
      });
      assert.ok(!("participantLabel" in createdSession));
      deps.__state.contextItems.push({
        itemId: "ctx_session_delete_target",
        scope: "session",
        layer: "core_fact",
        subjectKind: "session",
        subjectId: sessionId,
        sourceType: "fact",
        retrievalPolicy: "always",
        status: "active",
        sessionId,
        title: "会话用途",
        text: "此会话专门用于删除联动测试。",
        pinned: true,
        sensitivity: "normal",
        createdAt: 1,
        updatedAt: 1
      }, {
        itemId: "ctx_session_delete_other",
        scope: "session",
        layer: "core_fact",
        subjectKind: "session",
        subjectId: "web:other",
        sourceType: "fact",
        retrievalPolicy: "always",
        status: "active",
        sessionId: "web:other",
        title: "其他会话用途",
        text: "此会话不应被目标会话删除影响。",
        pinned: true,
        sensitivity: "normal",
        createdAt: 1,
        updatedAt: 1
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent(sessionId)}`
      });
      assert.equal(deleteResponse.statusCode, 200);
      assert.deepEqual(deps.__state.contextCleanupSessionIds, [sessionId]);
      assert.equal(deps.__state.sessionSnapshots.length, 0);
      assert.equal(deps.__state.contextItems.find((item) => item.itemId === "ctx_session_delete_target")?.status, "deleted");
      assert.equal(deps.__state.contextItems.find((item) => item.itemId === "ctx_session_delete_other")?.status, "active");

      const finalListResponse = await app.inject({
        method: "GET",
        url: "/api/sessions"
      });
      assert.ok(!finalListResponse.json().sessions.some((item: { id: string }) => item.id === sessionId));
    } finally {
      await app.close();
    }
  });

  test("create session accepts manual title and marks it manual", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { modeId: "scenario_host", title: "Warehouse infiltration" }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().session.title, "Warehouse infiltration");
      assert.equal(response.json().session.titleSource, "manual");
      assert.ok(!("participantLabel" in response.json().session));
    } finally {
      await app.close();
    }
  });

  test("internal api registers session list stream route", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      assert.match(app.printRoutes(), /s(?:.|\n)*ssion(?:.|\n)*s \(GET, HEAD, POST\)(?:.|\n)*stream \(GET, HEAD\)/);
    } finally {
      await app.close();
    }
  });

  test("internal api updates web session title", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Initial title" }
      });
      const sessionId = createResponse.json().session.id;

      const response = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/title`,
        payload: { title: "Updated title" }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().session.title, "Updated title");
      assert.equal(response.json().session.titleSource, "manual");

      const detail = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}`
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().session.title, "Updated title");
    } finally {
      await app.close();
    }
  });

  test("internal api reads and updates session pacing preferences", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Pacing" }
      });
      const sessionId = createResponse.json().session.id;

      const initialDetail = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}`
      });
      assert.deepEqual(initialDetail.json().session.pacingPreferences, {
        inputDebounce: { mode: "immediate" },
        oneBotOutbound: "immediate"
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/pacing`,
        payload: {
          inputDebounce: { mode: "fixed", delayMs: 2_500 },
          oneBotOutbound: "humanized"
        }
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().pacingPreferences, {
        inputDebounce: { mode: "fixed", delayMs: 2_500 },
        oneBotOutbound: "humanized"
      });

      const updatedDetail = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}`
      });
      assert.deepEqual(updatedDetail.json().session.pacingPreferences, response.json().pacingPreferences);

      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/pacing`,
        payload: {
          inputDebounce: { mode: "fixed", delayMs: 120_001 },
          oneBotOutbound: "immediate"
        }
      });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  test("internal api regenerates web session title and records transcript event", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Initial title" }
      });
      const sessionId = createResponse.json().session.id;

      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/title/regenerate`
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().session.title, "Generated title");
      assert.equal(response.json().session.titleSource, "auto");

      const detail = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}`
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().session.titleGenerationAvailable, true);
      assert.ok(detail.json().session.internalTranscript.some((item: { kind: string; source?: string; summary?: string }) => (
        item.kind === "title_generation_event"
        && item.source === "regenerate"
        && item.summary === "Generated title"
      )));
    } finally {
      await app.close();
    }
  });

  test("internal api rejects title regeneration when session captioner is unavailable", async () => {
    const deps = createInternalApiDeps();
    deps.sessionCaptioner = {
      isAvailable() {
        return false;
      },
      async generateTitle() {
        return "Should not be called";
      }
    } as unknown as typeof deps.sessionCaptioner;
    const app = await createInternalApiApp(deps);
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Initial title" }
      });
      const sessionId = createResponse.json().session.id;

      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/title/regenerate`
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "标题生成器不可用");
    } finally {
      await app.close();
    }
  });

  test("internal api rejects title regeneration for onebot sessions", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/qqbot:p:10001/title/regenerate"
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "Only web sessions support title regeneration");
    } finally {
      await app.close();
    }
  });

  test("internal api creates scenario_host web sessions with the scenario default title", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          modeId: "scenario_host"
        }
      });

      assert.equal(createResponse.statusCode, 200);
      const sessionId = createResponse.json().session.id;
      assert.equal(createResponse.json().session.source, "web");
      assert.equal(createResponse.json().session.title, "New Scenario");
      assert.equal(createResponse.json().session.titleSource, "default");
      assert.deepEqual(createResponse.json().session.participantRef, {
        kind: "user",
        id: "owner"
      });
      assert.ok(!("participantLabel" in createResponse.json().session));
      assert.ok(!("participantUserId" in createResponse.json().session));
      assert.equal(deps.__state.sessions.find((item) => item.id === sessionId)?.title, "New Scenario");
      assert.equal(deps.sessionManager.getPersistedSession(sessionId).title, "New Scenario");
      assert.equal(deps.sessionManager.getPersistedSession(sessionId).titleSource, "default");
    } finally {
      await app.close();
    }
  });

  test("internal api web-turn starts turn and streams page-scoped response without onebot send", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Alice" }
      });
      const sessionId = createResponse.json().session.id;

      const startResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn`,
        payload: { userId: "10001", senderName: "Alice", text: "hello from web" }
      });

      assert.equal(startResponse.statusCode, 200);
      const turnId = startResponse.json().turnId;
      assert.equal(typeof turnId, "string");
      assert.ok(turnId.length > 0);

      const streamResponse = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn/stream?turnId=${encodeURIComponent(turnId)}`
      });

      assert.equal(streamResponse.statusCode, 200);
      assert.match(streamResponse.body, /event: ready/);
      assert.match(streamResponse.body, /event: draft_delta/);
      assert.match(streamResponse.body, new RegExp(`web handled: ${sessionId}: hello from web`));
      assert.match(streamResponse.body, /event: complete/);
      assert.deepEqual(deps.__state.sentMessages, []);
    } finally {
      await app.close();
    }
  });

  test("internal api web-turn can inject into onebot sessions without sending to onebot", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const sessionId = "qqbot:p:10001";
      const startResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn`,
        payload: { userId: "10001", senderName: "Alice", text: "hello from panel" }
      });

      assert.equal(startResponse.statusCode, 200);
      const turnId = startResponse.json().turnId;
      const streamResponse = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn/stream?turnId=${encodeURIComponent(turnId)}`
      });

      assert.equal(streamResponse.statusCode, 200);
      assert.match(streamResponse.body, /event: draft_delta/);
      assert.match(streamResponse.body, /web handled: qqbot:p:10001: hello from panel/);
      assert.deepEqual(deps.__state.sentMessages, []);
    } finally {
      await app.close();
    }
  });

  test("internal api invalidates transcript items, groups, and later items with onebot deletion side effects", async () => {
    const deps = createInternalApiDeps();
    deps.__state.sessions[0]!.internalTranscript = [{
      id: "item-1",
      groupId: "group-1",
      runtimeExcluded: false,
      kind: "assistant_message",
      role: "assistant",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "hello",
      deliveryRef: {
        platform: "onebot",
        messageId: 41
      },
      timestampMs: 1
    }, {
      id: "item-2",
      groupId: "group-1",
      runtimeExcluded: false,
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: "working",
      timestampMs: 2
    }, {
      id: "item-3",
      groupId: "group-2",
      runtimeExcluded: false,
      kind: "assistant_message",
      role: "assistant",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "keep",
      timestampMs: 3
    }];
    const app = await createInternalApiApp(deps);
    try {
      const singleResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent("qqbot:p:10001")}/transcript/items/item-1`
      });
      assert.equal(singleResponse.statusCode, 200);
      assert.deepEqual(singleResponse.json().excludedItemIds, ["item-1"]);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[0]!.runtimeExcluded, true);
      assert.deepEqual(deps.__state.deletedMessageIds, [41]);

      const groupResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent("qqbot:p:10001")}/transcript/groups/group-1`
      });
      assert.equal(groupResponse.statusCode, 200);
      assert.deepEqual(groupResponse.json().excludedItemIds, ["item-2"]);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[1]!.runtimeExcluded, true);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[2]!.runtimeExcluded, false);

      const truncateResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent("qqbot:p:10001")}/transcript/items/item-1/after`
      });
      assert.equal(truncateResponse.statusCode, 200);
      assert.deepEqual(truncateResponse.json().excludedItemIds, ["item-3"]);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[2]!.runtimeExcluded, true);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[2]!.runtimeExclusionReason, "manual_truncate_after");
    } finally {
      await app.close();
    }
  });

  test("internal api accepts file upload payloads above the default fastify body limit", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const largeBuffer = Buffer.alloc(1024 * 1024 + 256 * 1024, 0xaa);
      const response = await app.inject({
        method: "POST",
        url: "/api/uploads/files",
        payload: {
          files: [{
            sourceName: "large.png",
            mimeType: "image/png",
            contentBase64: largeBuffer.toString("base64"),
            kind: "image"
          }]
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
      assert.equal(response.json().uploads[0].fileId, "file_image_1");
      assert.equal(response.json().uploads[0].sizeBytes, largeBuffer.byteLength);
    } finally {
      await app.close();
    }
  });

  test("internal api logs workspace upload failures before returning an error response", async () => {
    const deps = createInternalApiDeps();
    const capturedLogs: Array<{ message: string; payload: Record<string, unknown> }> = [];
    deps.logger = {
      warn(payload: Record<string, unknown>, message?: string) {
        capturedLogs.push({ message: message ?? "", payload });
      }
    } as typeof deps.logger;
    deps.chatFileStore.importBuffer = async () => {
      throw new Error("image decoder unavailable");
    };

    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/uploads/files",
        payload: {
          files: [{
            sourceName: "broken.png",
            mimeType: "image/png",
            contentBase64: Buffer.from("not really an image").toString("base64"),
            kind: "image"
          }]
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "image decoder unavailable");
      assert.equal(capturedLogs.length, 1);
      assert.equal(capturedLogs[0]?.message, "internal_api_upload_failed");
      assert.equal(capturedLogs[0]?.payload.path, "/api/uploads/files");
      assert.equal(capturedLogs[0]?.payload.fileCount, 1);
      assert.equal(capturedLogs[0]?.payload.error, "image decoder unavailable");
    } finally {
      await app.close();
    }
  });

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileConfigSchema, llmProviderCatalogSchema } from "#config/configModel.ts";
import { exportSchemaMeta } from "#data/schema/composites.ts";
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
        schemaMeta.fields.conversation.fields.historyCompression.description,
        "控制会话历史在过长时如何压缩。"
      );

      const providerCatalogMeta = exportSchemaMeta(llmProviderCatalogSchema) as any;
      assert.equal(providerCatalogMeta.kind, "record");
      assert.equal(providerCatalogMeta.value.fields.features.fields.thinking.title, "思考");
      assert.equal(providerCatalogMeta.value.fields.features.fields.search.title, "搜索");

      const fileSchemaMeta = exportSchemaMeta(fileConfigSchema) as any;
      assert.equal(fileSchemaMeta.kind, "object");
      assert.equal(fileSchemaMeta.fields.comfy.fields.aspectRatios.value.title, "宽高比");
      assert.equal(fileSchemaMeta.fields.comfy.fields.aspectRatios.value.fields.width.title, "宽度");
      assert.equal(fileSchemaMeta.fields.comfy.fields.aspectRatios.value.fields.height.title, "高度");
      assert.equal(fileSchemaMeta.fields.comfy.fields.templates.item.fields.parameterBindings.title, "参数绑定");
      assert.equal(
        fileSchemaMeta.fields.comfy.fields.templates.item.fields.parameterBindings.fields.positivePromptPath.title,
        "正向提示词路径"
      );
      assert.equal(
        fileSchemaMeta.fields.comfy.fields.templates.item.fields.parameterBindings.fields.widthPath.title,
        "宽度路径"
      );
      assert.equal(
        fileSchemaMeta.fields.comfy.fields.templates.item.fields.parameterBindings.fields.heightPath.title,
        "高度路径"
      );
    } finally {
      await app.close();
    }
  });

  test("internal api exposes config, whitelist, requests, and scheduler jobs", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const [configSummary, editors, whitelist, requests, jobs] = await Promise.all([
        app.inject({ method: "GET", url: "/api/config-summary" }),
        app.inject({ method: "GET", url: "/api/editors" }),
        app.inject({ method: "GET", url: "/api/whitelist" }),
        app.inject({ method: "GET", url: "/api/requests" }),
        app.inject({ method: "GET", url: "/api/scheduler/jobs" })
      ]);

      assert.equal(configSummary.statusCode, 200);
      assert.equal(editors.statusCode, 200);
      assert.equal(configSummary.json().runtimeMode, "onebot");
      assert.equal(configSummary.json().access.ownerId, "10001");
      assert.deepEqual(configSummary.json().access.whitelist.users, ["10001"]);
      assert.equal(configSummary.json().onebot.enabled, true);
      assert.ok(editors.json().resources.some((resource: { key: string }) => resource.key === "config"));
      assert.equal(
        editors.json().resources.find((resource: { key: string }) => resource.key === "users")?.title,
        "用户列表"
      );
      assert.equal(
        editors.json().resources.find((resource: { key: string }) => resource.key === "group_membership")?.title,
        "群成员缓存"
      );
      assert.equal(
        editors.json().resources.find((resource: { key: string }) => resource.key === "requests")?.title,
        "待处理请求"
      );
      assert.equal(
        editors.json().resources.find((resource: { key: string }) => resource.key === "global_rules")?.title,
        "全局规则列表"
      );
      assert.equal(
        editors.json().resources.find((resource: { key: string }) => resource.key === "toolset_rules")?.title,
        "工具集规则列表"
      );
      assert.deepEqual(whitelist.json().whitelist.users, ["10001"]);
      assert.deepEqual(requests.json().requests.groups, [{ groupId: "20002", userId: "10003" }]);
      assert.deepEqual(jobs.json().jobs, [{ id: "job-1", name: "daily" }]);
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
      assert.equal(editorResponse.json().editor.referenceValue.appName, "global-app");
      assert.equal(editorResponse.json().editor.currentValue.appName, undefined);
      assert.equal(editorResponse.json().editor.effectiveValue.appName, "global-app");
      assert.equal(editorResponse.json().editor.editorFeatures.unsetMode, "reference");
      assert.equal(editorResponse.json().editor.editorFeatures.unsetActionLabel, "恢复继承");

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

  test("internal api exposes single-file editor resources", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      await mkdir(deps.config.dataDir, { recursive: true });
      const whitelistPath = `${deps.config.dataDir}/whitelist.json`;
      const groupMembershipPath = `${deps.config.dataDir}/group-membership-cache.json`;
      await writeFile(whitelistPath, JSON.stringify({
        users: ["10001"],
        groups: ["20001"]
      }, null, 2), "utf8");
      await writeFile(groupMembershipPath, JSON.stringify({
        version: 1,
        groups: {
          "20001": {
            "10001": {
              isMember: true,
              verifiedAt: 1710000000000
            }
          }
        }
      }, null, 2), "utf8");

      const whitelistResponse = await app.inject({
        method: "GET",
        url: "/api/editors/whitelist"
      });
      const usersResponse = await app.inject({
        method: "GET",
        url: "/api/editors/users"
      });
      const groupMembershipResponse = await app.inject({
        method: "GET",
        url: "/api/editors/group_membership"
      });
      const globalRulesResponse = await app.inject({
        method: "GET",
        url: "/api/editors/global_rules"
      });
      const toolsetRulesResponse = await app.inject({
        method: "GET",
        url: "/api/editors/toolset_rules"
      });

      assert.equal(whitelistResponse.statusCode, 200);
      assert.equal(whitelistResponse.json().editor.kind, "single");
      assert.equal(whitelistResponse.json().editor.file.path, whitelistPath);
      assert.deepEqual(whitelistResponse.json().editor.currentValue.users, ["10001"]);
      assert.equal(whitelistResponse.json().editor.referenceValue, undefined);
      assert.deepEqual(whitelistResponse.json().editor.effectiveValue.users, ["10001"]);
      assert.equal(whitelistResponse.json().editor.schemaMeta.title, "白名单");
      assert.equal(whitelistResponse.json().editor.schemaMeta.options?.[0]?.title, "当前白名单");

      assert.equal(usersResponse.statusCode, 200);
      assert.equal(usersResponse.json().editor.kind, "single");
      assert.equal(usersResponse.json().editor.schemaMeta.item.title, "用户");
      assert.equal(usersResponse.json().editor.schemaMeta.item.fields.memories.title, "长期记忆");
      assert.equal(usersResponse.json().editor.schemaMeta.description, "按列表保存所有用户的基础资料和长期记忆。");

      assert.equal(groupMembershipResponse.statusCode, 200);
      assert.equal(groupMembershipResponse.json().editor.kind, "single");
      assert.equal(groupMembershipResponse.json().editor.file.path, groupMembershipPath);
      assert.equal(groupMembershipResponse.json().editor.schemaMeta.title, "群成员缓存");
      assert.equal(groupMembershipResponse.json().editor.schemaMeta.fields.groups.title, "群列表");
      assert.equal(
        groupMembershipResponse.json().editor.schemaMeta.fields.groups.description,
        "按群 ID 缓存成员校验结果。"
      );
      assert.equal(groupMembershipResponse.json().editor.schemaMeta.fields.groups.value.title, "成员列表");
      assert.equal(
        groupMembershipResponse.json().editor.schemaMeta.fields.groups.value.description,
        "按用户 ID 缓存成员校验结果。"
      );
      assert.equal(groupMembershipResponse.json().editor.schemaMeta.fields.groups.value.value.title, "成员记录");

      assert.equal(globalRulesResponse.statusCode, 200);
      assert.equal(globalRulesResponse.json().editor.kind, "single");
      assert.equal(globalRulesResponse.json().editor.schemaMeta.title, "全局规则列表");
      assert.equal(globalRulesResponse.json().editor.schemaMeta.description, "按列表保存可编辑的全局规则。");

      assert.equal(toolsetRulesResponse.statusCode, 200);
      assert.equal(toolsetRulesResponse.json().editor.kind, "single");
      assert.equal(toolsetRulesResponse.json().editor.schemaMeta.title, "工具集规则列表");
      assert.equal(toolsetRulesResponse.json().editor.schemaMeta.description, "按列表保存仅对指定工具集生效的规则。");
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
          sessionCaptioner: [],
          imageCaptioner: [],
          audioTranscription: [],
          turnPlanner: []
        }
      });
      assert.equal(editorResponse.json().editor.editorFeatures.unsetActionLabel, "回退到 default");
      assert.deepEqual(editorResponse.json().editor.currentValue.default, {
        mainSmall: [],
        mainLarge: [],
        summarizer: [],
        sessionCaptioner: [],
        imageCaptioner: [],
        audioTranscription: [],
        turnPlanner: []
      });
      assert.deepEqual(editorResponse.json().editor.currentValue.dev, {
        mainSmall: ["main"]
      });
      assert.deepEqual(editorResponse.json().editor.referenceValue.dev, {
        mainSmall: [],
        mainLarge: [],
        summarizer: [],
        sessionCaptioner: [],
        imageCaptioner: [],
        audioTranscription: [],
        turnPlanner: []
      });
      assert.deepEqual(editorResponse.json().editor.effectiveValue.dev, {
        mainSmall: ["main"],
        mainLarge: [],
        summarizer: [],
        sessionCaptioner: [],
        imageCaptioner: [],
        audioTranscription: [],
        turnPlanner: []
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
        sessionCaptioner: [],
        imageCaptioner: [],
        audioTranscription: [],
        turnPlanner: []
      });
      const saved = await readFile(catalogPath, "utf8");
      assert.match(saved, /default:/);
      assert.match(saved, /mainLarge: \[\]/);
      assert.match(saved, /summarizer: \[\]/);
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
            version: 1,
            currentSituation: "码头上空有钟声回荡。",
            currentLocation: "旧港码头",
            sceneSummary: "玩家刚抵达旧港。",
            player: {
              userId: "10001",
              displayName: "Alice"
            },
            inventory: [{ ownerId: "10001", item: "铜钥匙", quantity: 1 }],
            objectives: [{ id: "find-bell", title: "找到钟楼", status: "active", summary: "先去高处确认钟声来源" }],
            worldFacts: ["旧港每晚零点都会响钟。"],
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
      assert.deepEqual(updateResponse.json().modeState.state.inventory, [{ ownerId: "10001", item: "铜钥匙", quantity: 1 }]);

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
            version: 1,
            title: "坏数据"
          }
        }
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /currentSituation|player|inventory|objectives|worldFacts|flags|initialized|turnIndex/i);
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
      phase: { kind: "idle" },
      pendingMessages: [],
      internalTranscript: [],
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
      const [listResponse, getResponse, runResponse, interactResponse, readResponse, signalResponse, closeResponse] = await Promise.all([
        app.inject({ method: "GET", url: "/api/shell/sessions" }),
        app.inject({ method: "GET", url: "/api/shell/sessions/shell-1" }),
        app.inject({ method: "POST", url: "/api/shell/run", payload: { command: "pwd", cwd: "/tmp", tty: true } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/interact", payload: { input: "ls\n" } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/read" }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/signal", payload: { signal: "SIGTERM" } }),
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

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent(sessionId)}`
      });
      assert.equal(deleteResponse.statusCode, 200);

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

  test("internal api invalidates transcript items and groups and triggers onebot deletion side effects", async () => {
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

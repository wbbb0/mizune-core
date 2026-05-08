import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import ExcelJS from "exceljs";
import { getBuiltinTools } from "../../src/llm/tools/index.ts";
import { getBuiltinToolDescriptorByName } from "../../src/llm/tools/toolRegistry.ts";
import { scenarioHostToolHandlers } from "../../src/llm/tools/conversation/scenarioHostTools.ts";
import { sessionToolHandlers } from "../../src/llm/tools/conversation/sessionTools.ts";
import { resourceToolHandlers } from "../../src/llm/tools/runtime/resourceTools.ts";
import { debugToolHandlers } from "../../src/llm/tools/runtime/debugTools.ts";
import { shellToolHandlers } from "../../src/llm/tools/runtime/shellTools.ts";
import { timeToolHandlers } from "../../src/llm/tools/runtime/timeTools.ts";
import { assetDocumentToolHandlers } from "../../src/llm/tools/runtime/documentTools.ts";
import { localFileToolHandlers, chatFileToolHandlers } from "../../src/llm/tools/runtime/workspaceTools.ts";
import {
  browserDownloadPolicy,
  browserPagePolicy,
  browserProfilePolicy,
  browserScreenshotPolicy,
  chatFileListPolicy,
  fileSendPolicy,
  localFileListPolicy,
  localFileMutationPolicy,
  localFileReadPolicy,
  localFileSearchPolicy
} from "../../src/llm/tools/core/resultObservationPresets.ts";
import { setupDraftToolHandlers } from "../../src/llm/tools/conversation/setupDraftTools.ts";
import { profileToolHandlers } from "../../src/llm/tools/profile/profileTools.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { buildToolObservation } from "../../src/conversation/session/toolObservation.ts";

function createMediaToolVisibilityConfig(options: {
  mainSupportsVision?: boolean;
  imageInspectorEnabled?: boolean;
  imageInspectorRefs?: string[];
  inspectorSupportsVision?: boolean;
  textInspectorRefs?: string[];
} = {}) {
  return createTestAppConfig({
    llm: {
      imageInspector: {
        enabled: options.imageInspectorEnabled ?? true
      },
      models: {
        main: {
          supportsVision: options.mainSupportsVision ?? false
        },
        visualFallback: {
          provider: "test",
          model: "fake-visual-fallback",
          supportsThinking: false,
          thinkingControllable: true,
          supportsVision: true,
          supportsAudioInput: false,
          supportsSearch: false,
          supportsTools: true,
          preserveThinking: false
        },
        inspector: {
          provider: "test",
          model: "fake-inspector",
          supportsThinking: false,
          thinkingControllable: true,
          supportsVision: options.inspectorSupportsVision ?? true,
          supportsAudioInput: false,
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
          textInspector: options.textInspectorRefs ?? ["main"],
          sessionCaptioner: ["sessionCaptioner"],
          imageCaptioner: ["main"],
          imageInspector: options.imageInspectorRefs ?? ["inspector"],
          audioTranscription: ["transcription"],
          turnPlanner: ["main"]
        }
      }
    }
  });
}

  test("builtin tool list exposes forward, media, and message tools", async () => {
    const config = createForwardFeatureConfig();
    config.search.aliyunIqs.enabled = true;
    config.shell.enabled = true;
    const names = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    assert.ok(names.includes("end_turn_without_reply"));
    assert.ok(names.includes("list_session_modes"));
    assert.ok(names.includes("switch_session_mode"));
    assert.ok(names.includes("get_scenario_state"));
    assert.ok(names.includes("update_scenario_state"));
    assert.ok(names.includes("get_current_time"));
    assert.ok(names.includes("roll_dice"));
    assert.ok(names.includes("view_forward_record"));
    assert.ok(names.includes("view_current_group_info"));
    assert.ok(names.includes("list_current_group_announcements"));
    assert.ok(names.includes("view_current_group_announcement"));
    assert.ok(names.includes("list_current_group_files"));
    assert.ok(names.includes("download_current_group_file"));
    assert.ok(names.includes("list_current_group_members"));
    assert.ok(names.includes("asset_media_view"));
    assert.ok(names.includes("asset_media_inspect"));
    assert.ok(names.includes("view_message"));
    assert.ok(names.includes("download_message_file"));
    assert.ok(names.includes("asset_list"));
    assert.ok(names.includes("asset_send_to_chat"));
    assert.ok(names.includes("asset_document_overview"));
    assert.ok(names.includes("asset_document_read"));
    assert.ok(names.includes("asset_document_search"));
    assert.ok(names.includes("asset_document_inspect"));
    assert.ok(names.includes("filesystem_mkdir"));
    assert.ok(names.includes("filesystem_delete"));
    assert.ok(names.includes("filesystem_media_inspect"));
    assert.ok(names.includes("filesystem_send_to_chat"));
    assert.ok(names.includes("ground_with_google_search"));
    assert.ok(names.includes("search_with_iqs_lite_advanced"));
    assert.ok(names.includes("list_live_resources"));
    assert.ok(names.includes("capture_screenshot"));
    assert.ok(names.includes("manage_scheduled_job"));
    assert.ok(names.includes("respond_request"));
    assert.ok(names.includes("set_chat_permission"));
    assert.ok(names.includes("terminal_list"));
    assert.ok(names.includes("terminal_run"));
    assert.ok(names.includes("terminal_start"));
    assert.ok(names.includes("terminal_read"));
    assert.ok(names.includes("terminal_write"));
    assert.ok(names.includes("terminal_key"));
    assert.ok(names.includes("terminal_signal"));
    assert.ok(names.includes("terminal_stop"));
    assert.ok(!names.includes("shell_run"));
    assert.ok(names.includes("open_page"));
    assert.ok(names.includes("inspect_page"));
    assert.ok(names.includes("interact_with_page"));
    assert.ok(names.includes("close_page"));
  });

  test("current group context tools are visible only in non-web group chats", async () => {
    const config = createForwardFeatureConfig();
    const currentGroupToolNames = [
      "view_current_group_info",
      "list_current_group_announcements",
      "view_current_group_announcement",
      "list_current_group_files",
      "download_current_group_file",
      "list_current_group_members"
    ];
    const getNames = (sessionId: string, replyDelivery: "onebot" | "web") => new Set(
      getBuiltinTools("owner", config, undefined, {
        visibilityContext: { sessionId, replyDelivery }
      }).map((tool) => tool.function.name)
    );

    const onebotGroup = getNames("qqbot:g:123456", "onebot");
    for (const toolName of currentGroupToolNames) {
      assert.equal(onebotGroup.has(toolName), true, `${toolName} should be visible in onebot group chats`);
    }

    for (const names of [
      getNames("qqbot:p:10001", "onebot"),
      getNames("web:panel", "web"),
      getNames("qqbot:g:123456", "web")
    ]) {
      for (const toolName of currentGroupToolNames) {
        assert.equal(names.has(toolName), false, `${toolName} should be hidden outside non-web group chats`);
      }
    }
  });

  test("download tools are hidden when assets are disabled", async () => {
    const config = createForwardFeatureConfig();
    config.browser.enabled = true;
    config.chatFiles.enabled = false;
    const names = new Set(getBuiltinTools("owner", config, undefined, {
      visibilityContext: { sessionId: "qqbot:g:123456", replyDelivery: "onebot" }
    }).map((tool) => tool.function.name));

    assert.equal(names.has("list_current_group_files"), true);
    assert.equal(names.has("download_current_group_file"), false);
    assert.equal(names.has("download_asset"), false);
    assert.equal(names.has("read_download_resource"), false);
    assert.equal(names.has("cancel_download_resource"), false);
  });

  test("media view tools require main model vision while media inspection tools do not", async () => {
    const nonVisionConfig = createMediaToolVisibilityConfig();
    const nonVisionNames = getBuiltinTools("owner", null, nonVisionConfig, {
      modelRef: ["main"]
    }).map((tool) => tool.function.name);
    assert.ok(!nonVisionNames.includes("asset_media_view"));
    assert.ok(!nonVisionNames.includes("filesystem_media_view"));
    assert.ok(nonVisionNames.includes("asset_media_inspect"));
    assert.ok(nonVisionNames.includes("filesystem_media_inspect"));

    const visionConfig = createMediaToolVisibilityConfig({ mainSupportsVision: true });
    const visionNames = getBuiltinTools("owner", null, visionConfig, {
      modelRef: ["main"]
    }).map((tool) => tool.function.name);
    assert.ok(visionNames.includes("asset_media_view"));
    assert.ok(visionNames.includes("filesystem_media_view"));
    assert.ok(visionNames.includes("asset_media_inspect"));
    assert.ok(visionNames.includes("filesystem_media_inspect"));

    const fallbackVisionNames = getBuiltinTools("owner", null, nonVisionConfig, {
      modelRef: ["main", "visualFallback"]
    }).map((tool) => tool.function.name);
    assert.ok(fallbackVisionNames.includes("asset_media_view"));
    assert.ok(fallbackVisionNames.includes("filesystem_media_view"));
  });

  test("media inspection tools are hidden when the image inspector is disabled or unrouted", async () => {
    const disabledConfig = createMediaToolVisibilityConfig({ imageInspectorEnabled: false });
    const disabledNames = getBuiltinTools("owner", null, disabledConfig, {
      modelRef: ["main"]
    }).map((tool) => tool.function.name);
    assert.ok(!disabledNames.includes("asset_media_inspect"));
    assert.ok(!disabledNames.includes("filesystem_media_inspect"));

    const unroutedConfig = createMediaToolVisibilityConfig({ imageInspectorRefs: [] });
    const unroutedNames = getBuiltinTools("owner", null, unroutedConfig, {
      modelRef: ["main"]
    }).map((tool) => tool.function.name);
    assert.ok(!unroutedNames.includes("asset_media_inspect"));
    assert.ok(!unroutedNames.includes("filesystem_media_inspect"));

    const nonVisionInspectorConfig = createMediaToolVisibilityConfig({ inspectorSupportsVision: false });
    const nonVisionInspectorNames = getBuiltinTools("owner", null, nonVisionInspectorConfig, {
      modelRef: ["main"]
    }).map((tool) => tool.function.name);
    assert.ok(!nonVisionInspectorNames.includes("asset_media_inspect"));
    assert.ok(!nonVisionInspectorNames.includes("filesystem_media_inspect"));
  });

  test("filesystem_delete descriptor makes recursive directory deletion explicit", async () => {
    const config = createForwardFeatureConfig();
    const descriptor = getBuiltinTools("owner", config)
      .find((tool) => tool.function.name === "filesystem_delete");
    assert.ok(descriptor);
    assert.match(descriptor.function.description, /整个目录/);
    assert.match(descriptor.function.description, /递归删除/);
    assert.match(descriptor.function.description, /相对本地文件工作区根目录/);
  });

  test("terminal_key schema exposes semantic tmux keys and key queues", async () => {
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    const descriptor = getBuiltinTools("owner", config)
      .find((tool) => tool.function.name === "terminal_key");
    assert.ok(descriptor);
    const properties = descriptor.function.parameters?.properties as any;
    assert.ok(properties.key.enum.includes("tmux_split_right"));
    assert.ok(properties.key.enum.includes("tmux_detach"));
    assert.deepEqual(properties.keys.items.enum, properties.key.enum);
    assert.deepEqual(descriptor.function.parameters?.anyOf, [
      { required: ["resource_id", "key"] },
      { required: ["resource_id", "keys"] }
    ]);
  });

  test("terminal_run schema rejects non-positive timeout values", async () => {
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    const descriptor = getBuiltinTools("owner", config)
      .find((tool) => tool.function.name === "terminal_run");
    assert.ok(descriptor);
    const properties = descriptor.function.parameters?.properties as any;
    assert.equal(properties.timeout_ms.minimum, 1);
  });

  test("builtin tool list hides web tools when search is disabled", async () => {
    const config = createForwardFeatureConfig();
    config.search.googleGrounding.enabled = false;
    config.search.aliyunIqs.enabled = false;
    config.browser.enabled = false;
    config.shell.enabled = false;
    config.chatFiles.enabled = false;
    const names = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    assert.ok(!names.includes("ground_with_google_search"));
    assert.ok(!names.includes("search_with_iqs_lite_advanced"));
    assert.ok(!names.includes("list_live_resources"));
    assert.ok(!names.includes("capture_screenshot"));
    assert.ok(!names.includes("terminal_run"));
    assert.ok(!names.includes("open_page"));
    assert.ok(!names.includes("inspect_page"));
    assert.ok(!names.includes("interact_with_page"));
    assert.ok(!names.includes("close_page"));
  });

  test("web research descriptors bind the intended result observation policies", async () => {
    const config = createForwardFeatureConfig();
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("open_page", config)?.resultObservation), policyShape(browserPagePolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("inspect_page", config)?.resultObservation), policyShape(browserPagePolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("interact_with_page", config)?.resultObservation), policyShape(browserPagePolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("capture_screenshot", config)?.resultObservation), policyShape(browserScreenshotPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("download_asset", config)?.resultObservation), policyShape(browserDownloadPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("list_browser_profiles", config)?.resultObservation), policyShape(browserProfilePolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("save_browser_profile", config)?.resultObservation), policyShape(browserProfilePolicy()));
  });

  test("workspace descriptors bind compact file observation policies", async () => {
    const config = createForwardFeatureConfig();
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("filesystem_list", config)?.resultObservation), policyShape(localFileListPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("filesystem_read", config)?.resultObservation), policyShape(localFileReadPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("filesystem_search", config)?.resultObservation), policyShape(localFileSearchPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("filesystem_patch", config)?.resultObservation), policyShape(localFileMutationPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("filesystem_send_to_chat", config)?.resultObservation), policyShape(fileSendPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("asset_list", config)?.resultObservation), policyShape(chatFileListPolicy()));
    assert.deepEqual(policyShape(getBuiltinToolDescriptorByName("asset_send_to_chat", config)?.resultObservation), policyShape(fileSendPolicy()));
  });

  test("builtin tool list hides external search tools when provider native search is enabled", async () => {
    const config = createForwardFeatureConfig();
    config.search.googleGrounding.enabled = true;
    config.search.aliyunIqs.enabled = true;
    const testProvider = config.llm.providers.test;
    const mainModel = config.llm.models.main;
    assert.ok(testProvider);
    assert.ok(mainModel);
    testProvider.features.search = {
      type: "builtin_tool",
      tool: {
        type: "web_search_preview"
      }
    };
    mainModel.supportsSearch = true;

    const names = getBuiltinTools("owner", config, undefined, {
      modelRef: "main"
    }).map((tool) => tool.function.name);

    assert.ok(!names.includes("ground_with_google_search"));
    assert.ok(!names.includes("search_with_iqs_lite_advanced"));
  });

  test("all object tool schemas expose properties for provider compatibility", async () => {
    const tools = getBuiltinTools("owner", createForwardFeatureConfig());
    for (const tool of tools) {
      const parameters = tool.function.parameters ?? {};
      if (parameters.type === "object") {
        assert.ok(
          Object.prototype.hasOwnProperty.call(parameters, "properties"),
          `tool ${tool.function.name} is missing parameters.properties`
        );
      }
    }
  });

  test("debug-only tools stay hidden unless the current turn is in debug mode", async () => {
    const config = createForwardFeatureConfig();
    assert.ok(!getBuiltinTools("owner", config).map((tool) => tool.function.name).includes("dump_debug_literals"));
    assert.ok(getBuiltinTools("owner", config, undefined, {
      includeDebugTools: true
    }).map((tool) => tool.function.name).includes("dump_debug_literals"));
  });

  test("memory tool descriptions cover category-specific tool surface", async () => {
    const config = createForwardFeatureConfig();
    const tools = getBuiltinTools("owner", config);
    const getPersona = tools.find((tool) => tool.function.name === "get_persona");
    const upsertGlobalRule = tools.find((tool) => tool.function.name === "upsert_global_rule");
    const upsertUserMemory = tools.find((tool) => tool.function.name === "upsert_user_memory");
    assert.match(String(getPersona?.function.description ?? ""), /persona/);
    assert.match(String(upsertGlobalRule?.function.description ?? ""), /全局工作流规则/);
    assert.match(String(upsertUserMemory?.function.description ?? ""), /用户长期记忆/);
  });

  test("memory tools are exposed to both owner and known users", async () => {
    const config = createForwardFeatureConfig();
    const ownerNames = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    const knownNames = getBuiltinTools("known", config).map((tool) => tool.function.name);
    assert.ok(ownerNames.includes("get_persona"));
    assert.ok(ownerNames.includes("patch_persona"));
    assert.ok(ownerNames.includes("upsert_global_rule"));
    assert.ok(ownerNames.includes("upsert_toolset_rule"));
    assert.ok(ownerNames.includes("patch_user_profile"));
    assert.ok(ownerNames.includes("upsert_user_memory"));
    assert.ok(knownNames.includes("get_persona"));
    assert.ok(knownNames.includes("patch_user_profile"));
    assert.ok(knownNames.includes("upsert_user_memory"));
    assert.ok(!knownNames.includes("upsert_global_rule"));
    assert.ok(!knownNames.includes("upsert_toolset_rule"));
  });

  test("normal profile tool scope hides persona and mode profile write tools", async () => {
    const config = createForwardFeatureConfig();
    const names = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "normal"
    }).map((tool) => tool.function.name);
    assert.ok(names.includes("get_persona"));
    assert.ok(!names.includes("patch_persona"));
    assert.ok(!names.includes("clear_persona_field"));
    assert.ok(!names.includes("get_rp_profile"));
    assert.ok(!names.includes("patch_rp_profile"));
    assert.ok(!names.includes("clear_rp_profile_field"));
    assert.ok(!names.includes("get_scenario_profile"));
    assert.ok(!names.includes("patch_scenario_profile"));
    assert.ok(!names.includes("clear_scenario_profile_field"));
  });

  test("persona profile tool scope only exposes persona draft tools", async () => {
    const config = createForwardFeatureConfig();
    const names = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "persona"
    }).map((tool) => tool.function.name);
    assert.ok(names.includes("get_persona"));
    assert.ok(names.includes("patch_persona"));
    assert.ok(names.includes("clear_persona_field"));
    assert.ok(!names.includes("get_rp_profile"));
    assert.ok(!names.includes("patch_rp_profile"));
    assert.ok(!names.includes("get_scenario_profile"));
    assert.ok(!names.includes("patch_scenario_profile"));
  });

  test("rp and scenario profile tool scopes only expose their own draft tools", async () => {
    const config = createForwardFeatureConfig();
    const rpNames = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "rp"
    }).map((tool) => tool.function.name);
    const scenarioNames = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "scenario"
    }).map((tool) => tool.function.name);

    assert.ok(rpNames.includes("get_rp_profile"));
    assert.ok(rpNames.includes("patch_rp_profile"));
    assert.ok(rpNames.includes("clear_rp_profile_field"));
    assert.ok(!rpNames.includes("get_persona"));
    assert.ok(!rpNames.includes("patch_persona"));
    assert.ok(!rpNames.includes("get_scenario_profile"));

    assert.ok(scenarioNames.includes("get_scenario_profile"));
    assert.ok(scenarioNames.includes("patch_scenario_profile"));
    assert.ok(scenarioNames.includes("clear_scenario_profile_field"));
    assert.ok(!scenarioNames.includes("get_persona"));
    assert.ok(!scenarioNames.includes("patch_persona"));
    assert.ok(!scenarioNames.includes("get_rp_profile"));
  });

  test("profile draft handlers read and update operationMode drafts instead of stores", async () => {
    let personaOperationMode = {
      kind: "persona_config" as const,
      draft: {
        ...createEmptyPersona(),
        name: "小满"
      }
    };
    let rpOperationMode = {
      kind: "mode_config" as const,
      modeId: "rp_assistant" as const,
      draft: {
        ...createEmptyRpProfile(),
        selfPositioning: "雨夜里也保持镇定"
      }
    };

    const personaContext = {
      relationship: "owner",
      lastMessage: {
        sessionId: "web:persona-draft",
        userId: "owner",
        senderName: "Owner"
      },
      sessionManager: {
        getOperationMode() {
          return personaOperationMode;
        },
        setOperationMode(_sessionId: string, operationMode: typeof personaOperationMode) {
          personaOperationMode = operationMode;
          return operationMode;
        }
      }
    } as any;
    const rpContext = {
      relationship: "owner",
      lastMessage: {
        sessionId: "web:rp-draft",
        userId: "owner",
        senderName: "Owner"
      },
      sessionManager: {
        getOperationMode() {
          return rpOperationMode;
        },
        setOperationMode(_sessionId: string, operationMode: typeof rpOperationMode) {
          rpOperationMode = operationMode;
          return operationMode;
        }
      }
    } as any;

    await profileToolHandlers.patch_persona!(
      { id: "tool_persona_draft_patch_1", type: "function", function: { name: "patch_persona", arguments: "{\"personaPatch\":{\"speakingStyle\":\"短句\"}}" } },
      { personaPatch: { speakingStyle: "短句" } },
      personaContext
    );
    await profileToolHandlers.patch_rp_profile!(
      { id: "tool_rp_draft_patch_1", type: "function", function: { name: "patch_rp_profile", arguments: "{\"profilePatch\":{\"hardLimits\":\"绝不跳出角色\"}}" } },
      { profilePatch: { hardLimits: "绝不跳出角色" } },
      rpContext
    );

    assert.equal(personaOperationMode.draft.speakingStyle, "短句");
    assert.equal(rpOperationMode.draft.hardLimits, "绝不跳出角色");
    assert.equal(JSON.parse(String(await profileToolHandlers.get_persona!(
      { id: "tool_persona_draft_get_1", type: "function", function: { name: "get_persona", arguments: "{}" } },
      {},
      personaContext
    ))).speakingStyle, "短句");
    assert.equal(JSON.parse(String(await profileToolHandlers.get_rp_profile!(
      { id: "tool_rp_draft_get_1", type: "function", function: { name: "get_rp_profile", arguments: "{}" } },
      {},
      rpContext
    ))).hardLimits, "绝不跳出角色");
  });

  test("send_setup_draft uses committed text sink for web sessions", async () => {
    const appended: string[] = [];
    const historyCalls: Array<{ sessionId: string; message: Record<string, unknown> }> = [];

    const result = await setupDraftToolHandlers.send_setup_draft!(
      { id: "tool_setup_draft_web_1", type: "function", function: { name: "send_setup_draft", arguments: "{\"content\":\"当前草稿：名字=小满\"}" } },
      { content: "当前草稿：名字=小满" },
      {
        replyDelivery: "web",
        lastMessage: {
          sessionId: "web:persona-draft",
          userId: "owner",
          senderName: "Owner"
        },
        committedTextSink: {
          commitText(chunk: string) {
            appended.push(chunk);
          }
        },
        oneBotClient: {
          async sendText() {
            throw new Error("web draft should not use onebot sendText");
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> | void }) {
            void params.send();
          }
        },
        sessionManager: {
          getSession() {
            return { type: "private" };
          },
          appendAssistantHistory(sessionId: string, message: Record<string, unknown>) {
            historyCalls.push({ sessionId, message });
          }
        }
      } as any
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(JSON.parse(String(result)), { ok: true, queued: true, sent: true });
    assert.deepEqual(appended, ["当前草稿：名字=小满"]);
    assert.deepEqual(historyCalls, [{
      sessionId: "web:persona-draft",
      message: {
        chatType: "private",
        userId: "owner",
        senderName: "Owner",
        text: "当前草稿：名字=小满"
      }
    }]);
  });

  test("send_setup_draft keeps onebot delivery and records sent history for chat sessions", async () => {
    const sentTargets: Array<{ userId?: string; groupId?: string; text: string }> = [];
    const sentMessages: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
    const historyCalls: Array<{ sessionId: string; message: Record<string, unknown> }> = [];

    const result = await setupDraftToolHandlers.send_setup_draft!(
      { id: "tool_setup_draft_onebot_1", type: "function", function: { name: "send_setup_draft", arguments: "{\"content\":\"当前 RP 草稿：前提=雨夜\"}" } },
      { content: "当前 RP 草稿：前提=雨夜" },
      {
        replyDelivery: "onebot",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "owner",
          senderName: "Owner"
        },
        oneBotClient: {
          async sendText(target: { userId?: string; groupId?: string; text: string }) {
            sentTargets.push(target);
            return {
              data: {
                message_id: 12345
              }
            };
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> | void }) {
            void params.send();
          }
        },
        sessionManager: {
          getSession() {
            return { type: "private" };
          },
          recordSentMessage(sessionId: string, message: Record<string, unknown>) {
            sentMessages.push({ sessionId, message });
          },
          appendAssistantHistory(sessionId: string, message: Record<string, unknown>) {
            historyCalls.push({ sessionId, message });
          }
        }
      } as any
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(JSON.parse(String(result)), { ok: true, queued: true, sent: true });
    assert.deepEqual(sentTargets, [{
      userId: "10001",
      text: "当前 RP 草稿：前提=雨夜"
    }]);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.sessionId, "qqbot:p:10001");
    assert.equal(sentMessages[0]?.message.messageId, 12345);
    assert.equal(sentMessages[0]?.message.text, "当前 RP 草稿：前提=雨夜");
    assert.equal(typeof sentMessages[0]?.message.sentAt, "number");
    assert.deepEqual(historyCalls, [{
      sessionId: "qqbot:p:10001",
      message: {
        chatType: "private",
        userId: "owner",
        senderName: "Owner",
        text: "当前 RP 草稿：前提=雨夜",
        deliveryRef: {
          platform: "onebot",
          messageId: 12345
        }
      }
    }]);
  });

  test("old polymorphic memory tools are no longer exposed", async () => {
    const config = createForwardFeatureConfig();
    const toolNames = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    assert.ok(!toolNames.includes("read_memory"));
    assert.ok(!toolNames.includes("write_memory"));
    assert.ok(!toolNames.includes("remove_memory"));
  });

  test("global rule handlers allow owner and reject non-owner", async () => {
    const ownerResult = await profileToolHandlers.upsert_global_rule!(
      { id: "tool_global_rule_1", type: "function", function: { name: "upsert_global_rule", arguments: "{\"title\":\"输出顺序\",\"content\":\"先结论后细节\"}" } },
      { title: "输出顺序", content: "先结论后细节" },
      {
        relationship: "owner",
        globalRuleStore: {
          async upsert(input: { title: string; content: string }) {
            return { action: "created", item: { id: "rule_1", updatedAt: 1, createdAt: 1, kind: "workflow", source: "owner_explicit", ...input }, rules: [] };
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(ownerResult)).rule.title, "输出顺序");

    const deniedResult = await profileToolHandlers.upsert_global_rule!(
      { id: "tool_global_rule_2", type: "function", function: { name: "upsert_global_rule", arguments: "{\"title\":\"输出顺序\",\"content\":\"先结论后细节\"}" } },
      { title: "输出顺序", content: "先结论后细节" },
      {
        relationship: "known",
        globalRuleStore: {}
      } as any
    );
    assert.match(String(deniedResult), /Only owner can edit global rules/);
  });

  test("memory handlers surface structured scope conflict warnings", async () => {
    const personaWarningResult = await profileToolHandlers.patch_persona!(
      { id: "tool_persona_warn_1", type: "function", function: { name: "patch_persona", arguments: "{\"personaPatch\":{\"speakingStyle\":\"所有任务默认先给结论再展开\"}}" } },
      { personaPatch: { speakingStyle: "所有任务默认先给结论再展开" } },
      {
        relationship: "owner",
        personaStore: {
          isComplete() {
            return false;
          },
          async patchWithDiagnostics() {
            return {
              persona: {
                name: "",
                temperament: "",
                speakingStyle: "所有任务默认先给结论再展开",
                globalTraits: "",
                generalPreferences: ""
              },
              warning: {
                code: "warning_scope_conflict",
                currentScope: "persona",
                suggestedScope: "global_rules",
                reason: "内容更像跨任务长期工作流规则，不像 bot 的名字、性格底色、说话方式或跨模式全局偏好。"
              }
            };
          }
        },
        setupStore: {
          async advanceAfterPersonaUpdate() {
            return undefined;
          }
        },
        globalProfileReadinessStore: {
          async setPersonaReadiness() {
            return null;
          }
        }
      } as any
    );
    const personaPayload = JSON.parse(String(personaWarningResult));
    assert.equal(personaPayload.finalAction, "warning_scope_conflict");
    assert.equal(personaPayload.warnings[0].suggestedScope, "global_rules");

    const globalWarningResult = await profileToolHandlers.upsert_global_rule!(
      { id: "tool_global_rule_warn_1", type: "function", function: { name: "upsert_global_rule", arguments: "{\"title\":\"角色口吻\",\"content\":\"以后都用傲娇少女口吻说话\"}" } },
      { title: "角色口吻", content: "以后都用傲娇少女口吻说话" },
      {
        relationship: "owner",
        globalRuleStore: {
          async upsert(input: { title: string; content: string }) {
            return {
              action: "created",
              finalAction: "warning_scope_conflict",
              dedup: { matchedBy: "none", matchedExistingId: null },
              warning: {
                code: "warning_scope_conflict",
                currentScope: "global_rules",
                suggestedScope: "persona",
                reason: "内容更像 bot 的名字、性格底色、说话方式或跨模式全局偏好，而不是 owner 级通用工作流规则。"
              },
              item: { id: "rule_warn_1", updatedAt: 1, createdAt: 1, kind: "workflow", source: "owner_explicit", ...input },
              rules: []
            };
          }
        }
      } as any
    );
    const globalPayload = JSON.parse(String(globalWarningResult));
    assert.equal(globalPayload.finalAction, "warning_scope_conflict");
    assert.equal(globalPayload.warnings[0].suggestedScope, "persona");
    assert.equal(globalPayload.reroute.result, "not_rerouted_scope_warning");
    assert.equal(globalPayload.reroute.suggestedScope, "persona");

    const userWarningResult = await profileToolHandlers.upsert_user_memory!(
      { id: "tool_user_memory_warn_1", type: "function", function: { name: "upsert_user_memory", arguments: "{\"title\":\"叫我\",\"content\":\"以后叫我老王\"}" } },
      { title: "叫我", content: "以后叫我老王" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        contextStore: {
          upsertUserFact(input: { title: string; content: string }) {
            return {
              action: "created",
              finalAction: "warning_scope_conflict",
              dedup: { matchedBy: "none", matchedExistingId: null },
              warning: {
                code: "warning_scope_conflict",
                currentScope: "user_memories",
                suggestedScope: "user_profile",
                reason: "内容更像结构化用户卡片字段，适合写入 user profile。"
              },
              item: { id: "mem_warn_1", updatedAt: 1, createdAt: 1, kind: "other", source: "user_explicit", ...input },
            };
          }
        }
      } as any
    );
    const userPayload = JSON.parse(String(userWarningResult));
    assert.equal(userPayload.finalAction, "warning_scope_conflict");
    assert.equal(userPayload.warnings[0].suggestedScope, "user_profile");
    assert.equal(userPayload.reroute.result, "not_rerouted_scope_warning");
    assert.equal(userPayload.reroute.suggestedScope, "user_profile");
  });

  test("profile handlers preserve structured fields and user-memory handlers keep durable preferences in user memories", async () => {
    const profileResult = await profileToolHandlers.patch_user_profile!(
      { id: "tool_profile_patch_1", type: "function", function: { name: "patch_user_profile", arguments: "{\"timezone\":\"Asia/Shanghai\",\"occupation\":\"产品经理\",\"profileSummary\":\"做事很快\\n经常先给结论\"}" } },
      { timezone: "Asia/Shanghai", occupation: "产品经理", profileSummary: "做事很快\n经常先给结论" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        userStore: {
          async patchUserProfile() {
            return {
              userId: "10001",
              relationship: "known",
              timezone: "Asia/Shanghai",
              occupation: "产品经理",
              profileSummary: "做事很快；经常先给结论",
              memories: [],
              createdAt: 1
            };
          }
        }
      } as any
    );
    const profilePayload = JSON.parse(String(profileResult));
    assert.equal(profilePayload.targetCategory, "user_profile");
    assert.equal(profilePayload.profile.timezone, "Asia/Shanghai");
    assert.equal(profilePayload.profile.occupation, "产品经理");

    const userMemoryResult = await profileToolHandlers.upsert_user_memory!(
      { id: "tool_user_memory_boundary_1", type: "function", function: { name: "upsert_user_memory", arguments: "{\"title\":\"交流边界\",\"content\":\"不要替我做决定\"}" } },
      { title: "交流边界", content: "不要替我做决定" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        contextStore: {
          upsertUserFact(input: { title: string; content: string }) {
            return {
              action: "created",
              finalAction: "created",
              dedup: { matchedBy: "none", matchedExistingId: null },
              warning: null,
              item: { id: "mem_boundary_1", updatedAt: 1, createdAt: 1, kind: "boundary", source: "user_explicit", ...input },
            };
          }
        }
      } as any
    );
    const userMemoryPayload = JSON.parse(String(userMemoryResult));
    assert.equal(userMemoryPayload.targetCategory, "user_memories");
    assert.equal(userMemoryPayload.finalAction, "created");
    assert.equal(userMemoryPayload.memory.kind, "boundary");
    assert.equal(userMemoryPayload.reroute.result, "not_applicable");
  });

  test("profile memory handler resolves bound OneBot external user ids before writing", async () => {
    const writes: Array<{ userId: string; source: string | undefined }> = [];
    const result = await profileToolHandlers.upsert_user_memory!(
      { id: "tool_user_memory_external_id_1", type: "function", function: { name: "upsert_user_memory", arguments: "{\"user_id\":\"2254600711\",\"title\":\"骰子\",\"content\":\"使用 roll_dice\"}" } },
      { user_id: "2254600711", title: "骰子", content: "使用 roll_dice" },
      {
        relationship: "owner",
        lastMessage: {
          sessionId: "acc1:p:2254600711",
          userId: "owner",
          senderName: "Owner"
        },
        userIdentityStore: {
          async findInternalUserId(input: { channelId: string; externalId: string }) {
            return input.channelId === "acc1" && input.externalId === "2254600711"
              ? "owner"
              : undefined;
          }
        },
        contextStore: {
          upsertUserFact(input: { userId: string; source?: string; title: string; content: string }) {
            writes.push({ userId: input.userId, source: input.source });
            return {
              action: "created",
              finalAction: "created",
              dedup: { matchedBy: "none", matchedExistingId: null },
              warning: null,
              item: { id: "mem_owner_1", updatedAt: 1, createdAt: 1, kind: "preference", source: input.source, title: input.title, content: input.content },
            };
          }
        }
      } as any
    );

    assert.equal(writes[0]?.userId, "owner");
    assert.equal(writes[0]?.source, "user_explicit");
    assert.equal(JSON.parse(String(result)).itemId, "mem_owner_1");
  });

  test("profile memory handlers resolve current sender display name to current user", async () => {
    const inspectedUserIds: string[] = [];
    const result = await profileToolHandlers.list_user_memories!(
      { id: "tool_user_memory_sender_name_1", type: "function", function: { name: "list_user_memories", arguments: "{\"user_id\":\"CLI User\"}" } },
      { user_id: "CLI User" },
      {
        relationship: "owner",
        lastMessage: {
          sessionId: "acc1:p:30015",
          userId: "owner",
          senderName: "CLI User"
        },
        contextStore: {
          listUserFacts(userId: string) {
            inspectedUserIds.push(userId);
            return [];
          }
        }
      } as any
    );

    assert.deepEqual(inspectedUserIds, ["owner"]);
    assert.deepEqual(JSON.parse(String(result)), []);
  });

  test("profile memory handlers remove and replace memories by text query", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const removeResult = await profileToolHandlers.remove_user_memory!(
      { id: "tool_user_memory_remove_query_1", type: "function", function: { name: "remove_user_memory", arguments: "{\"query\":\"早餐\"}" } },
      { query: "早餐" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        contextStore: {
          removeUserFactByText(userId: string, query: string) {
            calls.push({ method: "removeByText", userId, query });
            return {
              removed: true,
              match: { id: "mem_breakfast", title: "早餐习惯", content: "早餐固定吃酸奶", updatedAt: 1 },
              candidates: [{ item: { id: "mem_breakfast", title: "早餐习惯", content: "早餐固定吃酸奶", updatedAt: 1 }, score: 1 }],
              suppressedSearchCount: 2,
              remaining: []
            };
          }
        }
      } as any
    );
    const removePayload = JSON.parse(String(removeResult));
    assert.equal(removePayload.removed, true);
    assert.equal(removePayload.matchedMemoryId, "mem_breakfast");
    assert.equal(removePayload.suppressedSearchCount, 2);

    const replaceResult = await profileToolHandlers.replace_user_memory!(
      { id: "tool_user_memory_replace_query_1", type: "function", function: { name: "replace_user_memory", arguments: "{\"query\":\"早餐\",\"title\":\"早餐习惯\",\"content\":\"早餐固定吃全麦吐司\"}" } },
      { query: "早餐", title: "早餐习惯", content: "早餐固定吃全麦吐司" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        contextStore: {
          replaceUserFactByText(input: Record<string, unknown>) {
            calls.push({ method: "replaceByText", ...input });
            return {
              replaced: true,
              match: { id: "mem_breakfast", title: "早餐习惯", content: "早餐固定吃酸奶", updatedAt: 1 },
              candidates: [],
              result: { item: { id: "mem_breakfast", title: "早餐习惯", content: "早餐固定吃全麦吐司" } },
              remaining: []
            };
          }
        }
      } as any
    );
    const replacePayload = JSON.parse(String(replaceResult));
    assert.equal(replacePayload.replaced, true);
    assert.equal(replacePayload.matchedMemoryId, "mem_breakfast");
    assert.equal(replacePayload.memory.content, "早餐固定吃全麦吐司");
    assert.deepEqual(calls, [
      { method: "removeByText", userId: "10001", query: "早餐" },
      {
        method: "replaceByText",
        userId: "10001",
        query: "早餐",
        title: "早餐习惯",
        content: "早餐固定吃全麦吐司",
        source: "user_explicit"
      }
    ]);
  });

  test("toolset rule handlers upsert duplicates into existing rules", async () => {
    const existing = [{
      id: "rule_1",
      title: "网页登录处理",
      content: "只有在明确遇到登录任务时，才读取并使用站点凭据。",
      toolsetIds: ["web_research"],
      source: "owner_explicit",
      createdAt: 1,
      updatedAt: 1
    }];
    const duplicateResult = await profileToolHandlers.upsert_toolset_rule!(
      { id: "tool_toolset_rule_1", type: "function", function: { name: "upsert_toolset_rule", arguments: "{\"title\":\"网页登录规则\",\"content\":\"只有在明确遇到登录任务时，才读取并使用站点凭据。\",\"toolset_ids\":[\"web_research\"]}" } },
      { title: "网页登录规则", content: "只有在明确遇到登录任务时，才读取并使用站点凭据。", toolset_ids: ["web_research"] },
      {
        relationship: "owner",
        toolsetRuleStore: {
          async upsert() {
            return {
              action: "updated_existing",
              dedup: {
                matchedBy: "near_duplicate",
                matchedExistingId: "rule_1",
                similarityScore: 0.88
              },
              item: existing[0],
              rules: existing
            };
          }
        }
      } as any
    );
    const duplicatePayload = JSON.parse(String(duplicateResult));
    assert.equal(duplicatePayload.action, "updated_existing");
    assert.equal(duplicatePayload.dedup.similarityScore, 0.88);

    const updateResult = await profileToolHandlers.upsert_toolset_rule!(
      { id: "tool_toolset_rule_2", type: "function", function: { name: "upsert_toolset_rule", arguments: "{\"ruleId\":\"rule_1\",\"title\":\"网页登录处理\",\"content\":\"遇到明确登录任务时才读取并使用站点凭据。\",\"toolset_ids\":[\"web_research\"]}" } },
      { ruleId: "rule_1", title: "网页登录处理", content: "遇到明确登录任务时才读取并使用站点凭据。", toolset_ids: ["web_research"] },
      {
        relationship: "owner",
        toolsetRuleStore: {
          async upsert(input: { ruleId?: string; title: string; content: string; toolsetIds: string[] }) {
            return {
              action: "updated_existing",
              item: {
                id: input.ruleId ?? "rule_1",
                title: input.title,
                content: input.content,
                toolsetIds: input.toolsetIds,
                source: "owner_explicit",
                createdAt: 1,
                updatedAt: 2
              },
              rules: []
            };
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(updateResult)).rule.id, "rule_1");
  });

  test("scheduler tool description emphasizes future triggers and self-contained instructions", async () => {
    const config = createForwardFeatureConfig();
    const tools = getBuiltinTools("owner", config);
    const createJob = tools.find((tool) => tool.function.name === "create_scheduled_job");
    assert.match(String(createJob?.function.description ?? ""), /未来某时提醒、延后处理或定期执行/);
    assert.match(String(createJob?.function.description ?? ""), /触发当时可直接执行的完整任务/);
    assert.match(String(createJob?.function.description ?? ""), /查资料、看图或调用其他工具/);
  });

  test("end_turn_without_reply requests a terminal empty response", async () => {
    const result = await sessionToolHandlers.end_turn_without_reply!(
      { id: "tool_end_turn_1", type: "function", function: { name: "end_turn_without_reply", arguments: "{\"reason\":\"明确收尾\"}" } },
      { reason: "明确收尾" },
      {} as any
    );

    assert.equal(typeof result, "object");
    assert.equal(JSON.parse(String((result as any).content)).ended, true);
    assert.equal((result as any).terminalResponse?.text, "");
  });

  test("session mode tools expose available modes and can switch to scenario_host in private chats", async () => {
    const listed = await sessionToolHandlers.list_session_modes!(
      { id: "tool_mode_list_1", type: "function", function: { name: "list_session_modes", arguments: "{}" } },
      {},
      {
        lastMessage: {
          sessionId: "qqbot:p:owner",
          userId: "owner",
          senderName: "Owner"
        },
        listSessionModes: () => [{
          id: "rp_assistant",
          title: "RP Assistant",
          description: "当前默认模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "assistant",
          title: "Assistant",
          description: "普通助手模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "scenario_host",
          title: "Scenario Host",
          description: "私聊剧情主持。",
          allowedChatTypes: ["private"]
        }],
        sessionManager: {
          getModeId() {
            return "rp_assistant";
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(listed)).currentModeId, "rp_assistant");

    const listedPayload = JSON.parse(String(listed));
    assert.equal(listedPayload.currentModeId, "rp_assistant");
    assert.equal(listedPayload.modes[1].id, "assistant");
    assert.equal(listedPayload.modes[2].id, "scenario_host");

    const switched = await sessionToolHandlers.switch_session_mode!(
      { id: "tool_mode_switch_1", type: "function", function: { name: "switch_session_mode", arguments: "{\"modeId\":\"scenario_host\"}" } },
      { modeId: "scenario_host" },
      {
        lastMessage: {
          sessionId: "qqbot:p:owner",
          userId: "owner",
          senderName: "Owner"
        },
        listSessionModes: () => [{
          id: "rp_assistant",
          title: "RP Assistant",
          description: "当前默认模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "assistant",
          title: "Assistant",
          description: "普通助手模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "scenario_host",
          title: "Scenario Host",
          description: "私聊剧情主持。",
          allowedChatTypes: ["private"]
        }],
        sessionManager: {
          getSession() {
            return {
              id: "qqbot:p:owner",
              type: "private",
              participantUserId: "owner",
              participantLabel: "Owner"
            };
          },
          getModeId() {
            return "rp_assistant";
          },
          setModeId() {
            return true;
          }
        },
        scenarioHostStateStore: {
          async ensureForSession() {
            return {};
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(switched)).toModeId, "scenario_host");
  });

  test("session mode tools reject scenario_host in group chats", async () => {
    const switched = await sessionToolHandlers.switch_session_mode!(
      { id: "tool_mode_switch_group_1", type: "function", function: { name: "switch_session_mode", arguments: "{\"modeId\":\"scenario_host\"}" } },
      { modeId: "scenario_host" },
      {
        lastMessage: {
          sessionId: "qqbot:g:1000",
          userId: "owner",
          senderName: "Owner"
        },
        sessionManager: {
          getSession() {
            return {
              id: "qqbot:g:1000",
              type: "group"
            };
          },
          getModeId() {
            return "rp_assistant";
          }
        }
      } as any
    );
    assert.match(String(switched), /does not support group chat/);
  });

  test("scenario_host tools read and update structured session state", async () => {
    let state = {
      version: 1 as const,
      currentSituation: "旧局势",
      currentLocation: null as string | null,
      sceneSummary: "",
      player: { userId: "owner", displayName: "Owner" },
      inventory: [] as Array<{ ownerId: string; item: string; quantity: number }>,
      objectives: [] as Array<{ id: string; title: string; status: "active" | "completed" | "failed"; summary: string }>,
      worldFacts: [] as string[],
      flags: {} as Record<string, string | number | boolean>,
      turnIndex: 0
    };
    const context = {
      lastMessage: {
        sessionId: "qqbot:p:owner",
        userId: "owner",
        senderName: "Owner"
      },
      sessionManager: {
        getModeId() {
          return "scenario_host";
        },
        getSession() {
          return {
            id: "qqbot:p:owner",
            participantUserId: "owner",
            participantLabel: "Owner"
          };
        }
      },
      scenarioHostStateStore: {
        async ensure() {
          return state;
        },
        async update(_sessionId: string, updater: (current: typeof state) => typeof state) {
          state = updater(state);
          return state;
        }
      },
      persistSession() {}
    } as any;

    const initial = await scenarioHostToolHandlers.get_scenario_state!(
      { id: "tool_scenario_get_1", type: "function", function: { name: "get_scenario_state", arguments: "{}" } },
      {},
      context
    );
    assert.ok(!("title" in JSON.parse(String(initial))));

    const updated = await scenarioHostToolHandlers.update_scenario_state!(
      { id: "tool_scenario_update_1", type: "function", function: { name: "update_scenario_state", arguments: "{\"title\":\"钟楼迷雾\",\"currentSituation\":\"玩家来到门前\",\"turnIndex\":2}" } },
      { title: "钟楼迷雾", currentSituation: "玩家来到门前", turnIndex: 2 },
      context
    );
    const updatedState = JSON.parse(String(updated));
    assert.equal(updatedState.turnIndex, 2);
    assert.equal(updatedState.currentSituation, "玩家来到门前");
    assert.ok(!("title" in updatedState));

    const worldFact = await scenarioHostToolHandlers.append_world_fact!(
      { id: "tool_scenario_fact_1", type: "function", function: { name: "append_world_fact", arguments: "{\"fact\":\"钟楼每隔一刻钟响一次\"}" } },
      { fact: "钟楼每隔一刻钟响一次" },
      context
    );
    assert.equal(JSON.parse(String(worldFact)).worldFacts[0], "钟楼每隔一刻钟响一次");
  });

  test("update_scenario_state ignores initialized field (only .confirm can set it)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tool-scenario-"));
    try {
      const { ScenarioHostStateStore } = await import("../../src/modes/scenarioHost/stateStore.ts");
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      const sessionId = "qqbot:p:u1";

      const handler = scenarioHostToolHandlers["update_scenario_state"];
      assert.ok(handler, "update_scenario_state handler must exist");

      // Initialize state first
      await store.ensure(sessionId, { playerUserId: "u1", playerDisplayName: "Alice" });

      const context = {
        lastMessage: { sessionId, userId: "u1", senderName: "Alice" },
        sessionManager: {
          getModeId() { return "scenario_host"; },
          getSession() {
            return {
              participantUserId: "u1",
              participantLabel: "Alice"
            };
          }
        },
        scenarioHostStateStore: store,
        persistSession: () => {}
      } as any;

      // Call with title only — it should be ignored and leave the state unchanged
      const result = await handler(
        { id: "tc1", function: { name: "update_scenario_state", arguments: "" } } as any,
        { title: "神秘城堡" },
        context
      );

      const parsed = JSON.parse(result as string);
      assert.equal(parsed.initialized, false, "initialized should remain false — only .confirm can set it");
      assert.ok(!("title" in parsed));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("get_current_time returns configured timezone and precise clock values", async () => {
    const result = await timeToolHandlers.get_current_time!(
      { id: "tool_time_1", type: "function", function: { name: "get_current_time", arguments: "{}" } },
      {},
      {
        config: createForwardFeatureConfig(),
        relationship: "owner",
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        currentUser: null,
        oneBotClient: {},
        requestStore: {},
        sessionManager: {},
        whitelistStore: {},
        scheduledJobStore: {},
        scheduler: {},
        shellRuntime: {},
        shellSessionRuntime: {},
        commandRuntime: {},
        tmuxRuntime: {},
        tmuxSessionStore: {},
        searchService: {},
        chatFileStore: {},
        mediaVisionService: {},
        mediaCaptionService: {},
        forwardResolver: {},
        userStore: {},
        personaStore: {},
        setupStore: {},
        conversationAccess: {},
        npcDirectory: {}
      } as any
    );
    const payload = JSON.parse(String(result));
    assert.equal(payload.timezone, "Asia/Shanghai");
    assert.match(payload.isoUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(payload.localTime, /^\d{4}\/\d{2}\/\d{2}/);
    assert.equal(typeof payload.nowMs, "number");
    assert.equal(typeof payload.weekday, "string");
  });

  test("asset_list exact lookup suggests view and send follow-ups", async () => {
    const result = await chatFileToolHandlers.asset_list!(
      { id: "tool_asset_list_1", type: "function", function: { name: "asset_list", arguments: "{\"asset_ref\":\"chat_test0001.png\"}" } },
      { asset_ref: "chat_test0001.png" },
      {
        chatFileStore: {
          async getFile() {
            return null;
          },
          async listFiles() {
            return [{
              fileId: "file_test_1",
              fileRef: "chat_test0001.png",
              kind: "image",
              origin: "browser_download",
              chatFilePath: "workspace/media/file_test_1.png",
              sourceName: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              createdAtMs: Date.now(),
              sourceContext: {},
              caption: null
            }];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.ok, true);
    assert.equal(payload.file.asset_handle.source, "asset");
    assert.equal(payload.file.asset_handle.asset_id, "file_test_1");
    assert.equal(payload.file.asset_handle.asset_ref, "chat_test0001.png");
    assert.deepEqual(payload.file.asset_handle.selector, {
      asset_id: "file_test_1",
      asset_ref: "chat_test0001.png"
    });
    assert.deepEqual(payload.file.asset_handle.legacy, {
      file_id: "file_test_1",
      file_ref: "chat_test0001.png",
      chat_file_path: "workspace/media/file_test_1.png"
    });
    assert.deepEqual(
      payload.next_actions.map((item: { tool: string }) => item.tool),
      ["asset_media_view", "asset_send_to_chat"]
    );
    assert.deepEqual(
      payload.file.handle_capabilities.map((item: { capability: string }) => item.capability),
      ["view_media", "inspect_media", "send_to_chat"]
    );
    assert.deepEqual(
      payload.file.asset_handle.capabilities.map((item: { capability: string; tool: string; args: Record<string, unknown> }) => [item.capability, item.tool, item.args]),
      [
        ["view_media", "asset_media_view", { asset_ref: "chat_test0001.png" }],
        ["inspect_media", "asset_media_inspect", { asset_ref: "chat_test0001.png" }],
        ["send_to_chat", "asset_send_to_chat", { asset_ref: "chat_test0001.png" }]
      ]
    );
    assert.deepEqual(
      payload.file.asset_handle.next_actions.map((item: { tool: string; args: Record<string, unknown> }) => [item.tool, item.args]),
      [
        ["asset_media_view", { asset_ref: "chat_test0001.png" }],
        ["asset_send_to_chat", { asset_ref: "chat_test0001.png" }]
      ]
    );
  });

  test("file handle hints honor chat and asset visible tool names separately", async () => {
    const result = await chatFileToolHandlers.asset_list!(
      { id: "tool_asset_list_visible_tools", type: "function", function: { name: "asset_list", arguments: "{\"asset_ref\":\"chat_test0001.png\"}" } },
      { asset_ref: "chat_test0001.png" },
      {
        debugSnapshot: {
          visibleToolNames: ["asset_send_to_chat", "asset_send_to_chat"]
        },
        chatFileStore: {
          async getFile() {
            return null;
          },
          async listFiles() {
            return [{
              fileId: "file_test_1",
              fileRef: "chat_test0001.png",
              kind: "image",
              origin: "browser_download",
              chatFilePath: "workspace/media/file_test_1.png",
              sourceName: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              createdAtMs: Date.now(),
              sourceContext: {},
              caption: null
            }];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.deepEqual(
      payload.file.handle_capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
      [["view_media", false], ["inspect_media", false], ["send_to_chat", true]]
    );
    assert.deepEqual(
      payload.file.asset_handle.capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
      [["view_media", false], ["inspect_media", false], ["send_to_chat", true]]
    );
    assert.equal(payload.file.asset_handle.capabilities.every((item: { args: Record<string, unknown> }) => !("asset_ids" in item.args) && !("file_ref" in item.args) && "asset_ref" in item.args), true);
    assert.deepEqual(
      payload.next_actions.map((item: { tool: string }) => item.tool),
      ["asset_send_to_chat"]
    );
  });

  test("asset handles only expose view capability for model-viewable images", async () => {
    const result = await chatFileToolHandlers.asset_list!(
      { id: "tool_asset_list_video_handle", type: "function", function: { name: "asset_list", arguments: "{\"asset_ref\":\"clip.mp4\"}" } },
      { asset_ref: "clip.mp4" },
      {
        chatFileStore: {
          async getFile() {
            return null;
          },
          async listFiles() {
            return [{
              fileId: "file_video_1",
              fileRef: "clip.mp4",
              kind: "video",
              origin: "browser_download",
              chatFilePath: "workspace/media/clip.mp4",
              sourceName: "clip.mp4",
              mimeType: "video/mp4",
              sizeBytes: 1024,
              createdAtMs: Date.now(),
              sourceContext: {},
              caption: null
            }];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.deepEqual(
      payload.file.handle_capabilities.map((item: { capability: string }) => item.capability),
      ["send_to_chat"]
    );
    assert.deepEqual(
      payload.file.asset_handle.capabilities.map((item: { capability: string }) => item.capability),
      ["send_to_chat"]
    );
    assert.deepEqual(
      payload.next_actions.map((item: { tool: string }) => item.tool),
      ["asset_send_to_chat"]
    );
    assert.deepEqual(
      payload.file.asset_handle.next_actions.map((item: { tool: string }) => item.tool),
      ["asset_send_to_chat"]
    );
  });

  test("empty visible tool list means asset handle tools are unavailable", async () => {
    const result = await chatFileToolHandlers.asset_list!(
      { id: "tool_asset_list_empty_visible", type: "function", function: { name: "asset_list", arguments: "{\"asset_ref\":\"chat_test0001.png\"}" } },
      { asset_ref: "chat_test0001.png" },
      {
        debugSnapshot: {
          visibleToolNames: []
        },
        chatFileStore: {
          async getFile() {
            return null;
          },
          async listFiles() {
            return [{
              fileId: "file_test_1",
              fileRef: "chat_test0001.png",
              kind: "image",
              origin: "browser_download",
              chatFilePath: "workspace/media/file_test_1.png",
              sourceName: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              createdAtMs: Date.now(),
              sourceContext: {},
              caption: null
            }];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.deepEqual(
      payload.file.handle_capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
      [["view_media", false], ["inspect_media", false], ["send_to_chat", false]]
    );
    assert.deepEqual(
      payload.file.asset_handle.capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
      [["view_media", false], ["inspect_media", false], ["send_to_chat", false]]
    );
    assert.deepEqual(payload.next_actions, []);
  });

  test("asset_list filters by query and reports list window metadata", async () => {
    const result = await chatFileToolHandlers.asset_list!(
      { id: "tool_asset_list_2", type: "function", function: { name: "asset_list", arguments: "{\"query\":\"report\",\"limit\":1}" } },
      { query: "report", limit: 1 },
      {
        chatFileStore: {
          async listFiles() {
            return [
              {
                fileId: "file_report_1",
                fileRef: "file_report_1.pdf",
                kind: "file",
                origin: "browser_download",
                chatFilePath: "workspace/media/file_report_1.pdf",
                sourceName: "Quarterly Report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 10,
                createdAtMs: 1,
                sourceContext: { source: "https://example.com/report.pdf" },
                caption: "report summary"
              },
              {
                fileId: "file_report_2",
                fileRef: "file_report_2.pdf",
                kind: "file",
                origin: "user_upload",
                chatFilePath: "workspace/media/file_report_2.pdf",
                sourceName: "Another report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 20,
                createdAtMs: 2,
                sourceContext: {},
                caption: null
              },
              {
                fileId: "file_chat_hidden",
                fileRef: "chat_hidden.png",
                kind: "image",
                origin: "chat_message",
                chatFilePath: "workspace/media/chat_hidden.png",
                sourceName: "report hidden.png",
                mimeType: "image/png",
                sizeBytes: 30,
                createdAtMs: 3,
                sourceContext: {},
                caption: null
              }
            ];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.ok, true);
    assert.equal(payload.totalMatched, 2);
    assert.equal(payload.returned, 1);
    assert.equal(payload.truncated, true);
    assert.equal(payload.filters.defaultExcludedOrigin, "chat_message");
    assert.deepEqual(payload.files.map((item: { file_ref: string }) => item.file_ref), ["file_report_1.pdf"]);
    assert.deepEqual(
      payload.files[0].asset_handle.capabilities.map((item: { capability: string }) => item.capability),
      ["send_to_chat", "document_overview", "document_read", "document_search", "document_inspect"]
    );
  });

  test("asset document tools overview, search and read text assets by asset ref", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-"));
    const filePath = join(tempDir, "notes.md");
    await writeFile(filePath, [
      "# Alpha",
      "第一段包含 needle 和说明。",
      "## Beta",
      "第二段继续描述。",
      "第三段 needle 再次出现。"
    ].join("\n"));
    const file = {
      fileId: "file_doc_1",
      fileRef: "notes.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/notes.md",
      sourceName: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 120,
      createdAtMs: 1,
      sourceContext: {},
      caption: null
    };
    const context = {
      debugSnapshot: {
        visibleToolNames: ["asset_document_overview", "asset_document_read", "asset_document_search", "asset_send_to_chat"]
      },
      chatFileStore: {
        async getFile(id: string) {
          return id === "file_doc_1" ? file : null;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath(id: string) {
          assert.equal(id, "file_doc_1");
          return filePath;
        }
      }
    } as any;

    try {
      const overview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"notes.md\"}" } },
        { asset_ref: "notes.md" },
        context
      )));
      assert.equal(overview.ok, true);
      assert.equal(overview.asset_handle.asset_id, "file_doc_1");
      assert.ok(overview.document.chunk_count >= 1);
      assert.match(overview.document.excerpt, /Alpha/);
      assert.equal("summary" in overview.document, false);
      assert.deepEqual(overview.document.headings.map((item: { text: string }) => item.text), ["Alpha", "Beta"]);

      const search = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_doc_search", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"notes.md\",\"query\":\"needle\"}" } },
        { asset_ref: "notes.md", query: "needle" },
        context
      )));
      assert.equal(search.returned, 2);
      assert.equal(search.total_matches, 2);
      assert.equal(search.truncated, false);
      assert.deepEqual(search.matches.map((item: { line_number: number }) => item.line_number), [2, 5]);
      assert.ok(search.matches.every((item: { chunk_id?: string }) => typeof item.chunk_id === "string" && item.chunk_id.startsWith("chunk_")));

      const read = JSON.parse(String(await assetDocumentToolHandlers.asset_document_read!(
        { id: "tool_asset_doc_read", type: "function", function: { name: "asset_document_read", arguments: "{\"asset_ref\":\"notes.md\",\"start_line\":2,\"line_count\":2}" } },
        { asset_ref: "notes.md", start_line: 2, line_count: 2 },
        context
      )));
      assert.equal(read.start_line, 2);
      assert.equal(read.end_line, 3);
      assert.match(read.content, /needle/);

      const outOfRange = JSON.parse(String(await assetDocumentToolHandlers.asset_document_read!(
        { id: "tool_asset_doc_read_oob", type: "function", function: { name: "asset_document_read", arguments: "{\"asset_ref\":\"notes.md\",\"start_line\":99}" } },
        { asset_ref: "notes.md", start_line: 99 },
        context
      )));
      assert.equal(outOfRange.out_of_range, true);
      assert.equal(outOfRange.content, "");

      let inspectedChunks: Array<{ startLine: number; endLine: number; text: string }> = [];
      const inspectContext = {
        ...context,
        textInspectionService: {
          async inspectPreparedText(input: any) {
            inspectedChunks = input.chunks;
            return {
              ok: true,
              requestedCount: input.chunks.length,
              results: input.chunks.map((chunk: any) => ({
                chunkId: chunk.chunkId,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                status: "answered",
                found: true,
                answer: `找到 ${input.question}`,
                evidence: ["needle detail"],
                confidenceNotes: [],
                rawAnswer: "{}",
                parseStatus: "parsed",
                schemaIssues: [],
                modelRef: "text-inspector"
              }))
            };
          }
        }
      } as any;
      const inspected = JSON.parse(String(await assetDocumentToolHandlers.asset_document_inspect!(
        { id: "tool_asset_doc_inspect", type: "function", function: { name: "asset_document_inspect", arguments: "{\"asset_ref\":\"notes.md\",\"question\":\"needle\"}" } },
        { asset_ref: "notes.md", question: "needle" },
        inspectContext
      )));
      assert.equal(inspected.ok, true);
      assert.equal(inspected.asset_handle.asset_id, "file_doc_1");
      assert.match(inspected.combined_answer, /找到 needle/);
      assert.ok(inspectedChunks.length > 0);
      assert.ok(inspectedChunks.some((chunk) => chunk.text.includes("needle")));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document overview writes and reuses model summary cache", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-summary-"));
    const filePath = join(tempDir, "summary.md");
    const cacheDir = join(tempDir, "documents", "file_summary_doc_1");
    await writeFile(filePath, "# Summary\n重要事实 A\n重要事实 B\n", "utf8");
    const file = {
      fileId: "file_summary_doc_1",
      fileRef: "summary.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/summary.md",
      sourceName: "summary.md",
      mimeType: "text/markdown",
      sizeBytes: 64,
      createdAtMs: 810,
      sourceContext: {},
      caption: null
    };
    let calls = 0;
    const context = {
      chatFileStore: {
        async getFile() {
          return file;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          return filePath;
        },
        resolveDocumentCacheDirectory() {
          return cacheDir;
        }
      },
      documentSummaryService: {
        isEnabled() {
          return true;
        },
        async summarizePreparedDocument() {
          calls += 1;
          return {
            ok: true,
            summary: {
              brief: "模型摘要",
              outline: ["Summary"],
              key_facts: ["重要事实 A"],
              limitations: [],
              modelRef: "summarizer-test"
            }
          };
        }
      }
    } as any;
    try {
      const first = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_summary_1", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"summary.md\"}" } },
        { asset_ref: "summary.md" },
        context
      )));
      assert.equal(first.document.summary.brief, "模型摘要");
      assert.equal(first.document.summary_cache_hit, false);
      assert.equal(calls, 1);
      assert.equal(JSON.parse(await readFile(join(cacheDir, "summary.json"), "utf8")).summary.brief, "模型摘要");

      const second = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_summary_2", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"summary.md\"}" } },
        { asset_ref: "summary.md" },
        context
      )));
      assert.equal(second.document.summary.brief, "模型摘要");
      assert.equal(second.document.summary_cache_hit, true);
      assert.equal(calls, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document search uses hybrid embedding search when configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-hybrid-"));
    const filePath = join(tempDir, "hybrid.md");
    const cacheDir = join(tempDir, "documents", "file_hybrid_doc_1");
    const content = [
      ...Array.from({ length: 42 }, (_, index) => `filler line ${index}`),
      "semantic answer lives here",
      "related renewal details"
    ].join("\n");
    await writeFile(filePath, content, "utf8");
    const file = {
      fileId: "file_hybrid_doc_1",
      fileRef: "hybrid.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/hybrid.md",
      sourceName: "hybrid.md",
      mimeType: "text/markdown",
      sizeBytes: Buffer.byteLength(content),
      createdAtMs: 811,
      sourceContext: {},
      caption: null
    };
    const context = {
      chatFileStore: {
        async getFile() {
          return file;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          return filePath;
        },
        resolveDocumentCacheDirectory() {
          return cacheDir;
        }
      },
      contextEmbeddingService: {
        isConfigured() {
          return true;
        },
        getStatus() {
          return {
            configured: true,
            modelRefs: ["embedding-test"],
            timeoutMs: 1000,
            textPreprocessVersion: "tp-v1",
            chunkerVersion: "chunk-v1"
          };
        },
        async embedTexts(texts: string[]) {
          return {
            profile: {
              profileId: "embedding:test",
              instanceName: "test",
              provider: "fake",
              model: "fake-embedding",
              dimension: 2,
              distance: "cosine",
              textPreprocessVersion: "tp-v1",
              chunkerVersion: "chunk-v1"
            },
            vectors: texts.map((text) => text.includes("semantic answer") || text.includes("renewal question") ? [1, 0] : [0, 1])
          };
        }
      }
    } as any;
    try {
      const result = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_doc_hybrid", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"hybrid.md\",\"query\":\"renewal question\"}" } },
        { asset_ref: "hybrid.md", query: "renewal question" },
        context
      )));
      assert.equal(result.ok, true);
      assert.equal(result.search_mode, "hybrid");
      assert.equal(result.embedding_profile_id, "embedding:test");
      assert.equal(result.embedding_cache_hit, false);
      assert.equal(result.matches[0].chunk_id, "chunk_2");
      assert.match(result.matches[0].snippet, /semantic answer/);
      const firstEmbeddingIndex = JSON.parse(await readFile(join(cacheDir, "embeddings.json"), "utf8"));
      assert.equal(firstEmbeddingIndex.embeddingProfileId, "embedding:test");
      assert.match(firstEmbeddingIndex.cacheProfileId, /embedding-test/);

      const changedProfileContext = {
        ...context,
        contextEmbeddingService: {
          ...context.contextEmbeddingService,
          getStatus() {
            return {
              configured: true,
              modelRefs: ["embedding-next"],
              timeoutMs: 1000,
              textPreprocessVersion: "tp-v2",
              chunkerVersion: "chunk-v1"
            };
          },
          async embedTexts(texts: string[]) {
            return {
              profile: {
                profileId: "embedding:next",
                instanceName: "test",
                provider: "fake",
                model: "fake-embedding-next",
                dimension: 2,
                distance: "cosine",
                textPreprocessVersion: "tp-v2",
                chunkerVersion: "chunk-v1"
              },
              vectors: texts.map((text) => text.includes("semantic answer") || text.includes("renewal question") ? [1, 0] : [0, 1])
            };
          }
        }
      } as any;
      const rebuilt = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_doc_hybrid_rebuild", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"hybrid.md\",\"query\":\"renewal question\"}" } },
        { asset_ref: "hybrid.md", query: "renewal question" },
        changedProfileContext
      )));
      assert.equal(rebuilt.search_mode, "hybrid");
      assert.equal(rebuilt.embedding_profile_id, "embedding:next");
      assert.equal(rebuilt.embedding_cache_hit, false);
      const rebuiltEmbeddingIndex = JSON.parse(await readFile(join(cacheDir, "embeddings.json"), "utf8"));
      assert.equal(rebuiltEmbeddingIndex.embeddingProfileId, "embedding:next");
      assert.match(rebuiltEmbeddingIndex.cacheProfileId, /embedding-next/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools treat csv with Excel mime as text", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-csv-"));
    const filePath = join(tempDir, "report.csv");
    await writeFile(filePath, "name,value\n付款期限,30天\n", "utf8");
    const file = {
      fileId: "file_csv_1",
      fileRef: "report.csv",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/report.csv",
      sourceName: "report.csv",
      mimeType: "application/vnd.ms-excel",
      sizeBytes: 64,
      createdAtMs: 1,
      sourceContext: {},
      caption: null
    };
    try {
      const result = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_csv_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"report.csv\"}" } },
        { asset_ref: "report.csv" },
        {
          chatFileStore: {
            async getFile() {
              return file;
            },
            async listFiles() {
              return [file];
            },
            async resolveAbsolutePath() {
              return filePath;
            }
          }
        } as any
      )));
      assert.equal(result.ok, true);
      assert.equal(result.document.parser, "plain_text_v1");
      assert.match(result.document.preview, /付款期限,30天/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools reuse cached parsed text across calls", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-cache-"));
    const filePath = join(tempDir, "cached.md");
    await writeFile(filePath, "# Cached\nneedle from first parse\n", "utf8");
    const file = {
      fileId: "file_cached_doc_1",
      fileRef: "cached.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/cached.md",
      sourceName: "cached.md",
      mimeType: "text/markdown",
      sizeBytes: 256,
      createdAtMs: 123,
      sourceContext: {},
      caption: null
    };
    const context = {
      chatFileStore: {
        async getFile() {
          return file;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          return filePath;
        }
      }
    } as any;

    try {
      const overview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_cache_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"cached.md\"}" } },
        { asset_ref: "cached.md" },
        context
      )));
      assert.equal(overview.ok, true);
      assert.equal(overview.document.cache_hit, false);

      const cachedOverview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_cache_overview_2", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"cached.md\"}" } },
        { asset_ref: "cached.md" },
        context
      )));
      assert.equal(cachedOverview.ok, true);
      assert.equal(cachedOverview.document.cache_hit, true);

      await rm(filePath, { force: true });
      const missingAfterCache = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_cache_missing", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"cached.md\"}" } },
        { asset_ref: "cached.md" },
        context
      )));
      assert.equal(missingAfterCache.ok, false);
      assert.equal(missingAfterCache.status, "parse_failed");
      assert.equal(missingAfterCache.error, "asset_file_unavailable");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools do not cache failed file resolution", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-cache-fail-"));
    const filePath = join(tempDir, "retry.md");
    await writeFile(filePath, "retry needle\n", "utf8");
    const file = {
      fileId: "file_retry_doc_1",
      fileRef: "retry.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/retry.md",
      sourceName: "retry.md",
      mimeType: "text/markdown",
      sizeBytes: 128,
      createdAtMs: 456,
      sourceContext: {},
      caption: null
    };
    let resolveCount = 0;
    const context = {
      chatFileStore: {
        async getFile() {
          return file;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          resolveCount += 1;
          if (resolveCount === 1) {
            throw new Error("temporarily unavailable");
          }
          return filePath;
        }
      }
    } as any;
    try {
      const first = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_cache_fail_1", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"retry.md\"}" } },
        { asset_ref: "retry.md" },
        context
      )));
      assert.equal(first.ok, false);
      assert.equal(first.error, "asset_file_unavailable");

      const second = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_doc_cache_fail_2", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"retry.md\",\"query\":\"needle\"}" } },
        { asset_ref: "retry.md", query: "needle" },
        context
      )));
      assert.equal(second.ok, true);
      assert.equal(second.returned, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools persist parsed text cache", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-persist-"));
    const filePath = join(tempDir, "persist.md");
    const cacheDir = join(tempDir, "documents", "file_persist_doc_1");
    await writeFile(filePath, "# Persist\npersisted needle\n", "utf8");
    const file = {
      fileId: "file_persist_doc_1",
      fileRef: "persist.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/persist.md",
      sourceName: "persist.md",
      mimeType: "text/markdown",
      sizeBytes: 256,
      createdAtMs: 801,
      sourceContext: {},
      caption: null
    };
    try {
      const overview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_persist_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"persist.md\"}" } },
        { asset_ref: "persist.md" },
        {
          chatFileStore: {
            async getFile() {
              return file;
            },
            async listFiles() {
              return [file];
            },
            async resolveAbsolutePath() {
              return filePath;
            },
            resolveDocumentCacheDirectory() {
              return cacheDir;
            }
          }
        } as any
      )));
      assert.equal(overview.ok, true);
      assert.equal(overview.document.cache_hit, false);
      assert.match(await readFile(join(cacheDir, "text.txt"), "utf8"), /persisted needle/);
      const manifest = JSON.parse(await readFile(join(cacheDir, "manifest.json"), "utf8"));
      assert.equal(manifest.cacheSchemaVersion, "document_asset_cache_v2");
      assert.equal(manifest.parserVersion, "document_parser_v1");
      assert.equal(manifest.chunkerVersion, "document_chunk_v1");
      assert.equal(manifest.summaryPromptVersion, "document_summary_prompt_v1");
      assert.equal(manifest.embeddingProfileId, "embedding_disabled");
      assert.equal(manifest.fileId, "file_persist_doc_1");
      assert.equal(manifest.sourceHash, createHash("sha256").update("# Persist\npersisted needle\n").digest("hex"));
      assert.equal(manifest.parser, "plain_text_v1");
      assert.equal(manifest.contentLength, "# Persist\npersisted needle\n".length);
      assert.equal(manifest.contentHash, createHash("sha256").update("# Persist\npersisted needle\n").digest("hex"));
      assert.equal(manifest.chunkVersion, "document_chunk_v1");
      assert.equal(manifest.chunkCount, 1);
      const chunks = (await readFile(join(cacheDir, "chunks.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(chunks, [{
        chunkId: "chunk_1",
        startLine: 1,
        endLine: 3,
        startOffset: 0,
        endOffset: "# Persist\npersisted needle\n".length
      }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools reuse persisted text cache when fingerprint matches", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-persist-hit-"));
    const filePath = join(tempDir, "cached.md");
    const cacheDir = join(tempDir, "documents", "file_persist_hit_doc_1");
    const sourceContent = "source text without the cached token\n";
    const persistedContent = "persisted_needle from saved extraction\n";
    await writeFile(filePath, sourceContent, "utf8");
    const fileStat = await stat(filePath);
    const file = {
      fileId: "file_persist_hit_doc_1",
      fileRef: "cached.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/cached.md",
      sourceName: "cached.md",
      mimeType: "text/markdown",
      sizeBytes: Buffer.byteLength(sourceContent),
      createdAtMs: 802,
      sourceContext: {},
      caption: null
    };
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "text.txt"), persistedContent, "utf8");
    await writeFile(join(cacheDir, "manifest.json"), `${JSON.stringify({
      cacheSchemaVersion: "document_asset_cache_v2",
      parserVersion: "document_parser_v1",
      chunkerVersion: "document_chunk_v1",
      summaryPromptVersion: "document_summary_prompt_v1",
      embeddingProfileId: "embedding_disabled",
      fileId: file.fileId,
      fileRef: file.fileRef,
      chatFilePath: file.chatFilePath,
      sizeBytes: file.sizeBytes,
      createdAtMs: file.createdAtMs,
      mimeType: file.mimeType,
      sourceName: file.sourceName,
      absolutePath: filePath,
      fileStatSize: fileStat.size,
      fileStatMtimeMs: fileStat.mtimeMs,
      sourceHash: createHash("sha256").update(sourceContent).digest("hex"),
      parser: "plain_text_v1",
      contentLength: persistedContent.length,
      contentHash: createHash("sha256").update(persistedContent).digest("hex"),
      chunkVersion: "document_chunk_v1",
      chunkCount: 1,
      updatedAtMs: 1
    }, null, 2)}\n`, "utf8");
    await writeFile(join(cacheDir, "chunks.jsonl"), `${JSON.stringify({
      chunkId: "chunk_1",
      startLine: 1,
      endLine: 2,
      startOffset: 0,
      endOffset: persistedContent.length
    })}\n`, "utf8");
    const context = {
      chatFileStore: {
        async getFile() {
          return file;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          return filePath;
        },
        resolveDocumentCacheDirectory() {
          return cacheDir;
        }
      }
    } as any;
    try {
      const overview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_persist_hit_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"cached.md\"}" } },
        { asset_ref: "cached.md" },
        context
      )));
      assert.equal(overview.ok, true);
      assert.equal(overview.document.cache_hit, true);
      assert.equal(overview.document.chunk_cache_hit, true);
      assert.equal(overview.document.chunk_count, 1);

      const search = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_doc_persist_hit_search", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"cached.md\",\"query\":\"persisted_needle\"}" } },
        { asset_ref: "cached.md", query: "persisted_needle" },
        context
      )));
      assert.equal(search.ok, true);
      assert.equal(search.returned, 1);
      assert.equal(search.matches[0].snippet, "persisted_needle from saved extraction");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools reject stale persisted chunk metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-stale-chunks-"));
    const filePath = join(tempDir, "stale.md");
    const cacheDir = join(tempDir, "documents", "file_stale_chunks_doc_1");
    const persistedContent = "first line\nstale_needle line\n";
    await writeFile(filePath, persistedContent, "utf8");
    const fileStat = await stat(filePath);
    const file = {
      fileId: "file_stale_chunks_doc_1",
      fileRef: "stale.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/stale.md",
      sourceName: "stale.md",
      mimeType: "text/markdown",
      sizeBytes: Buffer.byteLength(persistedContent),
      createdAtMs: 804,
      sourceContext: {},
      caption: null
    };
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "text.txt"), persistedContent, "utf8");
    await writeFile(join(cacheDir, "manifest.json"), `${JSON.stringify({
      cacheSchemaVersion: "document_asset_cache_v2",
      parserVersion: "document_parser_v1",
      chunkerVersion: "document_chunk_v1",
      summaryPromptVersion: "document_summary_prompt_v1",
      embeddingProfileId: "embedding_disabled",
      fileId: file.fileId,
      fileRef: file.fileRef,
      chatFilePath: file.chatFilePath,
      sizeBytes: file.sizeBytes,
      createdAtMs: file.createdAtMs,
      mimeType: file.mimeType,
      sourceName: file.sourceName,
      absolutePath: filePath,
      fileStatSize: fileStat.size,
      fileStatMtimeMs: fileStat.mtimeMs,
      sourceHash: createHash("sha256").update(persistedContent).digest("hex"),
      parser: "plain_text_v1",
      contentLength: persistedContent.length,
      contentHash: createHash("sha256").update(persistedContent).digest("hex"),
      chunkVersion: "document_chunk_v1",
      chunkCount: 1,
      updatedAtMs: 1
    }, null, 2)}\n`, "utf8");
    await writeFile(join(cacheDir, "chunks.jsonl"), `${JSON.stringify({
      chunkId: "chunk_1",
      startLine: 100,
      endLine: 101,
      startOffset: 0,
      endOffset: persistedContent.length
    })}\n`, "utf8");
    try {
      const context = {
        chatFileStore: {
          async getFile() {
            return file;
          },
          async listFiles() {
            return [file];
          },
          async resolveAbsolutePath() {
            return filePath;
          },
          resolveDocumentCacheDirectory() {
            return cacheDir;
          }
        }
      } as any;
      const overview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_stale_chunks_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"stale.md\"}" } },
        { asset_ref: "stale.md" },
        context
      )));
      assert.equal(overview.ok, true);
      assert.equal(overview.document.cache_hit, true);
      assert.equal(overview.document.chunk_cache_hit, false);

      const search = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_doc_stale_chunks_search", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"stale.md\",\"query\":\"stale_needle\"}" } },
        { asset_ref: "stale.md", query: "stale_needle" },
        context
      )));
      assert.equal(search.returned, 1);
      assert.equal(search.matches[0].line_number, 2);
      assert.equal(search.matches[0].start_line, 1);
      assert.equal(search.matches[0].end_line, 3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools keep CRLF line locators stable with persisted chunks", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-crlf-chunks-"));
    const filePath = join(tempDir, "crlf.md");
    const cacheDir = join(tempDir, "documents", "file_crlf_doc_1");
    const sourceContent = "alpha\r\nbeta needle\r\ngamma";
    await writeFile(filePath, sourceContent, "utf8");
    const file = {
      fileId: "file_crlf_doc_1",
      fileRef: "crlf.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/crlf.md",
      sourceName: "crlf.md",
      mimeType: "text/markdown",
      sizeBytes: Buffer.byteLength(sourceContent),
      createdAtMs: 805,
      sourceContext: {},
      caption: null
    };
    const context = {
      chatFileStore: {
        async getFile() {
          return file;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          return filePath;
        },
        resolveDocumentCacheDirectory() {
          return cacheDir;
        }
      }
    } as any;
    try {
      const first = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_crlf_overview_1", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"crlf.md\"}" } },
        { asset_ref: "crlf.md" },
        context
      )));
      assert.equal(first.ok, true);
      assert.equal(first.document.chunk_cache_hit, false);

      const second = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_doc_crlf_search", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"crlf.md\",\"query\":\"needle\"}" } },
        { asset_ref: "crlf.md", query: "needle" },
        context
      )));
      assert.equal(second.returned, 1);
      assert.equal(second.matches[0].line_number, 2);
      assert.equal(second.matches[0].start_line, 1);
      assert.equal(second.matches[0].end_line, 3);

      const chunks = (await readFile(join(cacheDir, "chunks.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(chunks, [{
        chunkId: "chunk_1",
        startLine: 1,
        endLine: 3,
        startOffset: 0,
        endOffset: "alpha\nbeta needle\ngamma".length
      }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools enforce actual stat size when source file changes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-doc-stat-size-"));
    const filePath = join(tempDir, "oversized.md");
    await writeFile(filePath, "x".repeat(2 * 1024 * 1024 + 1), "utf8");
    const file = {
      fileId: "file_oversized_doc_1",
      fileRef: "oversized.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/oversized.md",
      sourceName: "oversized.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
      createdAtMs: 803,
      sourceContext: {},
      caption: null
    };
    try {
      const overview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_doc_stat_size_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"oversized.md\"}" } },
        { asset_ref: "oversized.md" },
        {
          chatFileStore: {
            async getFile() {
              return file;
            },
            async listFiles() {
              return [file];
            },
            async resolveAbsolutePath() {
              return filePath;
            }
          }
        } as any
      )));
      assert.equal(overview.ok, false);
      assert.equal(overview.status, "too_large");
      assert.equal(overview.error, "document_too_large");
      assert.match(overview.reason, /2097153 bytes/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document search and inspect keep long-line matches beyond inspect chunk limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-long-line-"));
    const filePath = join(tempDir, "long.json");
    const longLine = `${"x".repeat(1800)} late_needle value`;
    await writeFile(filePath, longLine, "utf8");
    const file = {
      fileId: "file_long_doc_1",
      fileRef: "long.json",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/long.json",
      sourceName: "long.json",
      mimeType: "application/json",
      sizeBytes: longLine.length,
      createdAtMs: 789,
      sourceContext: {},
      caption: null
    };
    let inspectedText = "";
    let inspectedChunkKeys: string[] = [];
    const context = {
      chatFileStore: {
        async getFile() {
          return file;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          return filePath;
        }
      },
      textInspectionService: {
        async inspectPreparedText(input: any) {
          inspectedText = input.chunks[0]?.text ?? "";
          inspectedChunkKeys = Object.keys(input.chunks[0] ?? {}).sort();
          return {
            ok: true,
            requestedCount: input.chunks.length,
            results: input.chunks.map((chunk: any) => ({
              chunkId: chunk.chunkId,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              status: "answered",
              found: true,
              answer: "late needle found",
              evidence: ["late_needle"],
              confidenceNotes: [],
              rawAnswer: "{}",
              parseStatus: "parsed",
              schemaIssues: [],
              modelRef: "text-inspector"
            }))
          };
        }
      }
    } as any;

    try {
      const search = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_long_search", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"long.json\",\"query\":\"late_needle\"}" } },
        { asset_ref: "long.json", query: "late_needle" },
        context
      )));
      assert.equal(search.ok, true);
      assert.equal(search.returned, 1);
      assert.equal(search.total_matches, 1);
      assert.match(search.matches[0].snippet, /late_needle/);
      assert.equal(search.matches[0].line_number, 1);
      assert.equal(search.matches[0].chunk_id, "chunk_1");
      assert.equal(search.matches[0].char_start, 1801);
      assert.equal(search.matches[0].char_end, 1812);

      const inspected = JSON.parse(String(await assetDocumentToolHandlers.asset_document_inspect!(
        { id: "tool_asset_long_inspect", type: "function", function: { name: "asset_document_inspect", arguments: "{\"asset_ref\":\"long.json\",\"question\":\"what is late_needle\"}" } },
        { asset_ref: "long.json", question: "what is late_needle" },
        context
      )));
      assert.equal(inspected.ok, true);
      assert.match(inspectedText, /late_needle/);
      assert.ok(inspectedText.length < longLine.length);
      assert.ok(inspectedText.length <= 1200);
      assert.deepEqual(inspectedChunkKeys, ["chunkId", "endLine", "startLine", "text"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document inspect keeps boundary windows within chunk limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-window-boundary-"));
    const filePath = join(tempDir, "boundary.md");
    const longLine = `${"x".repeat(590)} late_needle value ${"y".repeat(1000)}`;
    await writeFile(filePath, longLine, "utf8");
    const file = {
      fileId: "file_boundary_doc_1",
      fileRef: "boundary.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/boundary.md",
      sourceName: "boundary.md",
      mimeType: "text/markdown",
      sizeBytes: longLine.length,
      createdAtMs: 791,
      sourceContext: {},
      caption: null
    };
    let inspectedText = "";
    try {
      const inspected = JSON.parse(String(await assetDocumentToolHandlers.asset_document_inspect!(
        { id: "tool_asset_boundary_inspect", type: "function", function: { name: "asset_document_inspect", arguments: "{\"asset_ref\":\"boundary.md\",\"question\":\"what is late_needle\"}" } },
        { asset_ref: "boundary.md", question: "what is late_needle" },
        {
          chatFileStore: {
            async getFile() {
              return file;
            },
            async listFiles() {
              return [file];
            },
            async resolveAbsolutePath() {
              return filePath;
            }
          },
          textInspectionService: {
            async inspectPreparedText(input: any) {
              inspectedText = input.chunks[0]?.text ?? "";
              return {
                ok: true,
                requestedCount: input.chunks.length,
                results: input.chunks.map((chunk: any) => ({
                  chunkId: chunk.chunkId,
                  startLine: chunk.startLine,
                  endLine: chunk.endLine,
                  status: "answered",
                  found: true,
                  answer: "late needle found",
                  evidence: ["late_needle"],
                  confidenceNotes: [],
                  rawAnswer: "{}",
                  parseStatus: "parsed",
                  schemaIssues: [],
                  modelRef: "text-inspector"
                }))
              };
            }
          }
        } as any
      )));
      assert.equal(inspected.ok, true);
      assert.match(inspectedText, /late_needle/);
      assert.ok(inspectedText.length <= 1200);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document search reports total matches and truncation across chunk boundaries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-search-limit-"));
    const filePath = join(tempDir, "many.md");
    const lines = Array.from({ length: 90 }, (_item, index) => [0, 44, 88].includes(index)
      ? `line ${index + 1} boundary_needle`
      : `line ${index + 1} ordinary text`);
    await writeFile(filePath, lines.join("\n"), "utf8");
    const file = {
      fileId: "file_many_doc_1",
      fileRef: "many.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/many.md",
      sourceName: "many.md",
      mimeType: "text/markdown",
      sizeBytes: 4096,
      createdAtMs: 790,
      sourceContext: {},
      caption: null
    };
    try {
      const search = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_many_search", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"many.md\",\"query\":\"boundary_needle\",\"limit\":2}" } },
        { asset_ref: "many.md", query: "boundary_needle", limit: 2 },
        {
          chatFileStore: {
            async getFile() {
              return file;
            },
            async listFiles() {
              return [file];
            },
            async resolveAbsolutePath() {
              return filePath;
            }
          }
        } as any
      )));
      assert.equal(search.returned, 2);
      assert.equal(search.total_matches, 3);
      assert.equal(search.truncated, true);
      assert.equal(search.matches[0].chunk_id, "chunk_1");
      assert.ok(search.matches[0].start_line <= search.matches[0].line_number);
      assert.ok(search.matches[0].end_line >= search.matches[0].line_number);
      assert.equal(search.matches[1].line_number, 45);
      assert.equal(search.matches[1].chunk_id, "chunk_2");
      assert.equal(search.matches[1].start_line, 41);
      assert.equal(search.matches[1].end_line, 80);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools keep legacy xls unsupported", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-xls-"));
    const filePath = join(tempDir, "legacy.xls");
    await writeFile(filePath, "not a real xls", "utf8");
    try {
      const result = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_xls_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"legacy.xls\"}" } },
        { asset_ref: "legacy.xls" },
        {
          chatFileStore: {
            async getFile() {
              return {
                fileId: "file_xls_1",
                fileRef: "legacy.xls",
                kind: "file",
                origin: "user_upload",
                chatFilePath: "workspace/media/legacy.xls",
                sourceName: "legacy.xls",
                mimeType: "application/vnd.ms-excel",
                sizeBytes: 64,
                createdAtMs: 1,
                sourceContext: {},
                caption: null
              };
            },
            async listFiles() {
              return [];
            },
            async resolveAbsolutePath() {
              return filePath;
            }
          }
        } as any
      )));
      assert.equal(result.ok, false);
      assert.equal(result.status, "unsupported");
      assert.equal(result.error, "unsupported_document_parser");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document inspect selects later Chinese matching chunks", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-zh-inspect-"));
    const filePath = join(tempDir, "contract.md");
    const lines = Array.from({ length: 260 }, (_item, index) => `第 ${index + 1} 行普通背景内容`);
    lines[230] = "付款期限为验收通过后三十日内完成。";
    lines[232] = "违约责任包括每日按未付款金额的千分之一支付违约金。";
    await writeFile(filePath, lines.join("\n"), "utf8");
    const file = {
      fileId: "file_contract_1",
      fileRef: "contract.md",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/contract.md",
      sourceName: "contract.md",
      mimeType: "text/markdown",
      sizeBytes: 4096,
      createdAtMs: 1,
      sourceContext: {},
      caption: null
    };
    let inspectedChunks: Array<{ startLine: number; endLine: number; text: string }> = [];
    try {
      const result = JSON.parse(String(await assetDocumentToolHandlers.asset_document_inspect!(
        { id: "tool_asset_zh_inspect", type: "function", function: { name: "asset_document_inspect", arguments: "{\"asset_ref\":\"contract.md\",\"question\":\"付款期限和违约责任是什么？\",\"max_chunks\":1}" } },
        { asset_ref: "contract.md", question: "付款期限和违约责任是什么？", max_chunks: 1 },
        {
          chatFileStore: {
            async getFile() {
              return file;
            },
            async listFiles() {
              return [file];
            },
            async resolveAbsolutePath() {
              return filePath;
            }
          },
          textInspectionService: {
            async inspectPreparedText(input: any) {
              inspectedChunks = input.chunks;
              return {
                ok: true,
                requestedCount: input.chunks.length,
                results: input.chunks.map((chunk: any) => ({
                  chunkId: chunk.chunkId,
                  startLine: chunk.startLine,
                  endLine: chunk.endLine,
                  status: "answered",
                  found: true,
                  answer: "付款期限和违约责任均已找到。",
                  evidence: ["付款期限", "违约责任"],
                  confidenceNotes: [],
                  rawAnswer: "{}",
                  parseStatus: "parsed",
                  schemaIssues: [],
                  modelRef: "text-inspector"
                }))
              };
            }
          }
        } as any
      )));
      assert.equal(result.ok, true);
      assert.equal(inspectedChunks.length, 1);
      assert.match(inspectedChunks[0]?.text ?? "", /付款期限/);
      assert.match(inspectedChunks[0]?.text ?? "", /违约责任/);
      assert.ok((inspectedChunks[0]?.startLine ?? 0) > 200);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document observation preserves read locator snippet and asset handle in replay", () => {
    const policy = getBuiltinToolDescriptorByName("asset_document_read", createForwardFeatureConfig())?.resultObservation;
    assert.ok(policy);
    const longContent = "重要正文 ".repeat(500);
    const observation = buildToolObservation({
      toolName: "asset_document_read",
      toolCallId: "tool_asset_doc_obs",
      args: { asset_ref: "notes.md", start_line: 1 },
      content: JSON.stringify({
        ok: true,
        status: "ready",
        asset_handle: {
          source: "asset",
          asset_id: "file_doc_1",
          asset_ref: "notes.md",
          selector: { asset_ref: "notes.md", asset_id: "file_doc_1" },
          kind: "file",
          capabilities: [{
            capability: "document_read",
            tool: "asset_document_read",
            available: true,
            args: { asset_ref: "notes.md" }
          }]
        },
        start_line: 1,
        end_line: 80,
        total_lines: 100,
        truncated: true,
        content: longContent
      }),
      policy
    });
    assert.equal(observation.retention, "summary");
    assert.equal(observation.preserveRecentRawCount, 0);
    const replay = JSON.parse(observation.replayContent);
    assert.match(replay.data.read.snippet, /重要正文/);
    assert.equal("content" in replay.data.read, false);
    assert.equal(replay.data.assetHandle.assetId, "file_doc_1");
    assert.deepEqual(
      replay.data.assetHandle.capabilities.map((item: { capability: string }) => item.capability),
      ["document_read"]
    );
  });

  test("asset document observation preserves asset handle for unsupported parser results", () => {
    const policy = getBuiltinToolDescriptorByName("asset_document_overview", createForwardFeatureConfig())?.resultObservation;
    assert.ok(policy);
    const observation = buildToolObservation({
      toolName: "asset_document_overview",
      toolCallId: "tool_asset_doc_unsupported_obs",
      args: { asset_ref: "report.pdf" },
      content: JSON.stringify({
        ok: false,
        status: "unsupported",
        error: "unsupported_document_parser",
        reason: ".pdf needs parser dependency",
        asset_handle: {
          source: "asset",
          asset_id: "file_pdf_1",
          asset_ref: "report.pdf",
          selector: { asset_ref: "report.pdf", asset_id: "file_pdf_1" },
          kind: "file",
          capabilities: [{
            capability: "document_overview",
            tool: "asset_document_overview",
            available: true,
            args: { asset_ref: "report.pdf" }
          }]
        }
      }),
      policy
    });
    const replay = JSON.parse(observation.replayContent);
    assert.equal(replay.ok, false);
    assert.equal(replay.data.status, "unsupported");
    assert.equal(replay.data.assetHandle.assetId, "file_pdf_1");
    assert.deepEqual(
      replay.data.assetHandle.capabilities.map((item: { capability: string }) => item.capability),
      ["document_overview"]
    );
  });

  test("asset document observation preserves search chunk locators", () => {
    const policy = getBuiltinToolDescriptorByName("asset_document_search", createForwardFeatureConfig())?.resultObservation;
    assert.ok(policy);
    const observation = buildToolObservation({
      toolName: "asset_document_search",
      toolCallId: "tool_asset_doc_search_obs",
      args: { asset_ref: "notes.md", query: "needle" },
      content: JSON.stringify({
        ok: true,
        status: "ready",
        asset_handle: {
          source: "asset",
          asset_id: "file_doc_1",
          asset_ref: "notes.md",
          selector: { asset_ref: "notes.md", asset_id: "file_doc_1" },
          kind: "file",
          capabilities: [{
            capability: "document_search",
            tool: "asset_document_search",
            available: true,
            args: { asset_ref: "notes.md" }
          }]
        },
        query: "needle",
        matches: [{
          chunk_id: "chunk_2",
          start_line: 41,
          end_line: 80,
          line_number: 55,
          char_start: 8,
          char_end: 14,
          snippet: "needle detail"
        }],
        returned: 1,
        total_matches: 1,
        truncated: false
      }),
      policy
    });
    const replay = JSON.parse(observation.replayContent);
    assert.equal(replay.data.search.matches[0].chunkId, "chunk_2");
    assert.equal(replay.data.search.matches[0].startLine, 41);
    assert.equal(replay.data.search.matches[0].endLine, 80);
    assert.equal(replay.data.search.matches[0].lineNumber, 55);
    assert.equal(replay.data.search.matches[0].charStart, 8);
    assert.equal(replay.data.search.matches[0].charEnd, 14);
  });

  test("asset document observation compacts text inspection results", () => {
    const policy = getBuiltinToolDescriptorByName("asset_document_inspect", createForwardFeatureConfig())?.resultObservation;
    assert.ok(policy);
    const observation = buildToolObservation({
      toolName: "asset_document_inspect",
      toolCallId: "tool_asset_doc_inspect_obs",
      args: { asset_ref: "notes.md", question: "总结关键点" },
      content: JSON.stringify({
        ok: true,
        status: "ready",
        asset_handle: {
          source: "asset",
          asset_id: "file_doc_1",
          asset_ref: "notes.md",
          selector: { asset_ref: "notes.md", asset_id: "file_doc_1" },
          kind: "file",
          capabilities: [{
            capability: "document_inspect",
            tool: "asset_document_inspect",
            available: true,
            args: { asset_ref: "notes.md" }
          }]
        },
        question: "总结关键点",
        combined_answer: "L1-L3: 关键点 A",
        selected_chunks: [{ chunk_id: "chunk_1", start_line: 1, end_line: 3, preview: "关键点 A" }],
        inspection: {
          ok: true,
          requestedCount: 1,
          results: [{
            chunkId: "chunk_1",
            startLine: 1,
            endLine: 3,
            status: "answered",
            found: true,
            answer: "关键点 A",
            evidence: ["原文证据"],
            confidenceNotes: [],
            modelRef: "text-inspector",
            schemaIssues: []
          }]
        }
      }),
      policy
    });
    const replay = JSON.parse(observation.replayContent);
    assert.equal(replay.data.assetHandle.assetId, "file_doc_1");
    assert.equal(replay.data.inspect.combinedAnswer, "L1-L3: 关键点 A");
    assert.equal(replay.data.inspect.results[0].modelRef, "text-inspector");
    assert.equal(replay.data.inspect.results[0].evidence[0], "原文证据");
  });

  test("asset document observation marks text inspection failures as replay errors", () => {
    const policy = getBuiltinToolDescriptorByName("asset_document_inspect", createForwardFeatureConfig())?.resultObservation;
    assert.ok(policy);
    const observation = buildToolObservation({
      toolName: "asset_document_inspect",
      toolCallId: "tool_asset_doc_inspect_failed_obs",
      args: { asset_ref: "notes.md", question: "总结关键点" },
      content: JSON.stringify({
        ok: false,
        status: "inspection_failed",
        error: "text_inspection_failed",
        asset_handle: {
          source: "asset",
          asset_id: "file_doc_1",
          asset_ref: "notes.md",
          selector: { asset_ref: "notes.md", asset_id: "file_doc_1" },
          kind: "file",
          capabilities: [{
            capability: "document_inspect",
            tool: "asset_document_inspect",
            available: true,
            args: { asset_ref: "notes.md" }
          }]
        },
        question: "总结关键点",
        combined_answer: "L1-L3: 文本精读模型未启用或未配置。",
        inspection: {
          ok: false,
          requestedCount: 1,
          results: [{
            chunkId: "chunk_1",
            startLine: 1,
            endLine: 3,
            status: "error",
            found: null,
            answer: "文本精读模型未启用或未配置。",
            evidence: [],
            confidenceNotes: [],
            modelRef: "unknown",
            schemaIssues: ["not_configured"]
          }]
        }
      }),
      policy
    });
    const replay = JSON.parse(observation.replayContent);
    assert.equal(replay.ok, false);
    assert.equal(replay.data.error, "text_inspection_failed");
    assert.equal(replay.data.inspect.results[0].status, "error");
  });

  test("download observation preserves asset handle document capabilities in replay", () => {
    const policy = getBuiltinToolDescriptorByName("download_asset", createForwardFeatureConfig())?.resultObservation;
    assert.ok(policy);
    const observation = buildToolObservation({
      toolName: "download_asset",
      toolCallId: "tool_download_obs",
      args: { url: "https://example.com/notes.md" },
      content: JSON.stringify({
        ok: true,
        status: "completed",
        file_id: "file_doc_1",
        asset_ref: "notes.md",
        asset_handle: {
          source: "asset",
          asset_id: "file_doc_1",
          asset_ref: "notes.md",
          selector: { asset_ref: "notes.md", asset_id: "file_doc_1" },
          kind: "file",
          capabilities: [{
            capability: "document_overview",
            tool: "asset_document_overview",
            available: true,
            args: { asset_ref: "notes.md" }
          }]
        }
      }),
      policy
    });
    const replay = JSON.parse(observation.replayContent);
    assert.equal(replay.data.assetHandle.assetId, "file_doc_1");
    assert.deepEqual(
      replay.data.assetHandle.capabilities.map((item: { capability: string }) => item.capability),
      ["document_overview"]
    );
  });

  test("asset document tools return parse_failed when registered file is unavailable", async () => {
    const result = await assetDocumentToolHandlers.asset_document_read!(
      { id: "tool_asset_doc_missing_file", type: "function", function: { name: "asset_document_read", arguments: "{\"asset_ref\":\"missing.md\"}" } },
      { asset_ref: "missing.md" },
      {
        chatFileStore: {
          async getFile() {
            return {
              fileId: "file_missing_1",
              fileRef: "missing.md",
              kind: "file",
              origin: "user_upload",
              chatFilePath: "workspace/media/missing.md",
              sourceName: "missing.md",
              mimeType: "text/markdown",
              sizeBytes: 100,
              createdAtMs: 1,
              sourceContext: {},
              caption: null
            };
          },
          async listFiles() {
            return [];
          },
          async resolveAbsolutePath() {
            throw new Error("file is gone");
          }
        }
      } as any
    );
    const payload = JSON.parse(String(result));
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "parse_failed");
    assert.equal(payload.error, "asset_file_unavailable");
    assert.equal(payload.asset_handle.asset_ref, "missing.md");

    const policy = getBuiltinToolDescriptorByName("asset_document_read", createForwardFeatureConfig())?.resultObservation;
    assert.ok(policy);
    const observation = buildToolObservation({
      toolName: "asset_document_read",
      toolCallId: "tool_asset_doc_missing_obs",
      args: { asset_ref: "missing.md" },
      content: String(result),
      policy
    });
    const replay = JSON.parse(observation.replayContent);
    assert.equal(replay.ok, false);
    assert.equal(replay.data.assetHandle.assetRef, "missing.md");
  });

  test("asset document tools parse xlsx assets as sheet csv text", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-xlsx-"));
    const filePath = join(tempDir, "scores.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Scores");
    sheet.addRows([
      ["name", "score"],
      ["alpha", 10],
      ["needle", 42]
    ]);
    await workbook.xlsx.writeFile(filePath);
    const file = {
      fileId: "file_xlsx_1",
      fileRef: "scores.xlsx",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "workspace/media/scores.xlsx",
      sourceName: "scores.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 4096,
      createdAtMs: 1,
      sourceContext: {},
      caption: null
    };
    const context = {
      chatFileStore: {
        async getFile(id: string) {
          return id === "file_xlsx_1" ? file : null;
        },
        async listFiles() {
          return [file];
        },
        async resolveAbsolutePath() {
          return filePath;
        }
      }
    } as any;

    try {
      const overview = JSON.parse(String(await assetDocumentToolHandlers.asset_document_overview!(
        { id: "tool_asset_xlsx_overview", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_ref\":\"scores.xlsx\"}" } },
        { asset_ref: "scores.xlsx" },
        context
      )));
      assert.equal(overview.ok, true);
      assert.equal(overview.document.parser, "exceljs_xlsx_csv_v1");
      assert.match(overview.document.preview, /# Sheet: Scores/);
      assert.match(overview.document.preview, /needle,42/);

      const search = JSON.parse(String(await assetDocumentToolHandlers.asset_document_search!(
        { id: "tool_asset_xlsx_search", type: "function", function: { name: "asset_document_search", arguments: "{\"asset_ref\":\"scores.xlsx\",\"query\":\"needle\"}" } },
        { asset_ref: "scores.xlsx", query: "needle" },
        context
      )));
      assert.equal(search.returned, 1);
      assert.match(search.matches[0].snippet, /needle,42/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset document tools report parse failure for invalid pdf assets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-invalid-pdf-"));
    const filePath = join(tempDir, "report.pdf");
    await writeFile(filePath, Buffer.from("not a pdf"));
    const result = await assetDocumentToolHandlers.asset_document_overview!(
      { id: "tool_asset_doc_pdf", type: "function", function: { name: "asset_document_overview", arguments: "{\"asset_id\":\"file_pdf_1\"}" } },
      { asset_id: "file_pdf_1" },
      {
        chatFileStore: {
          async getFile(id: string) {
            return id === "file_pdf_1"
              ? {
                  fileId: "file_pdf_1",
                  fileRef: "report.pdf",
                  kind: "file",
                  origin: "browser_download",
                  chatFilePath: "workspace/media/report.pdf",
                  sourceName: "report.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 500,
                  createdAtMs: 1,
                  sourceContext: {},
                  caption: null
                }
              : null;
          },
          async listFiles() {
            return [];
          },
          async resolveAbsolutePath() {
            return filePath;
          }
        }
      } as any
    );
    try {
      const payload = JSON.parse(String(result));
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "parse_failed");
      assert.equal(payload.error, "pdf_parse_failed");
      assert.equal(payload.asset_handle.asset_ref, "report.pdf");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset_list clamps malformed limit values to schema bounds", async () => {
    const files = Array.from({ length: 120 }, (_, index) => ({
      fileId: `file_${index}`,
      fileRef: `file_${index}.txt`,
      kind: "file",
      origin: "browser_download",
      chatFilePath: `workspace/media/file_${index}.txt`,
      sourceName: `file-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: index,
      createdAtMs: index,
      sourceContext: {},
      caption: null,
      captionStatus: "missing"
    }));
    const context = {
      chatFileStore: {
        async listFiles() {
          return files;
        }
      }
    } as any;

    const zero = await chatFileToolHandlers.asset_list!(
      { id: "tool_asset_list_limit_zero", type: "function", function: { name: "asset_list", arguments: "{\"limit\":0}" } },
      { limit: 0 },
      context
    );
    const zeroPayload = JSON.parse(String(zero));
    assert.equal(zeroPayload.filters.limit, 1);
    assert.equal(zeroPayload.returned, 1);

    const huge = await chatFileToolHandlers.asset_list!(
      { id: "tool_asset_list_limit_huge", type: "function", function: { name: "asset_list", arguments: "{\"limit\":1000}" } },
      { limit: 1000 },
      context
    );
    const hugePayload = JSON.parse(String(huge));
    assert.equal(hugePayload.filters.limit, 100);
    assert.equal(hugePayload.returned, 100);
    assert.equal(hugePayload.truncated, true);
  });

  test("filesystem_read truncated output suggests the next read range", async () => {
    const result = await localFileToolHandlers.filesystem_read!(
      { id: "tool_filesystem_read_1", type: "function", function: { name: "filesystem_read", arguments: "{\"path\":\"logs/app.log\"}" } },
      { path: "logs/app.log" },
      {
        localFileService: {
          async readFile(path: string) {
            assert.equal(path, "logs/app.log");
            return {
              path,
              content: "line 1\nline 2",
              startLine: 1,
              endLine: 2,
              totalLines: 5,
              truncated: true
            };
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.truncated, true);
    assert.deepEqual(payload.next_actions[0], {
      tool: "filesystem_read",
      reason: "继续读取剩余内容",
      args: { path: "logs/app.log", start_line: 3, end_line: 5 }
  });
});

  test("filesystem_list single-file result includes a local file handle", async () => {
    const result = await localFileToolHandlers.filesystem_list!(
      { id: "tool_filesystem_list_handle", type: "function", function: { name: "filesystem_list", arguments: "{\"path\":\"docs/readme.md\"}" } },
      { path: "docs/readme.md" },
      {
        debugSnapshot: {
          visibleToolNames: ["filesystem_read", "filesystem_send_to_chat"]
        },
        localFileService: {
          async statItem(path: string) {
            assert.equal(path, "docs/readme.md");
            return {
              path,
              name: "readme.md",
              kind: "file",
              sizeBytes: 42,
              updatedAtMs: 123
            };
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.handle.source, "filesystem");
    assert.equal(payload.handle.selector.path, "docs/readme.md");
    assert.deepEqual(
      payload.handle_capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
      [["read_text", true], ["send_to_chat", true]]
    );
    assert.deepEqual(
      payload.next_actions.map((item: { tool: string }) => item.tool),
      ["filesystem_read", "filesystem_send_to_chat"]
    );
  });

  test("empty visible tool list means local file handle tools are unavailable", async () => {
    const result = await localFileToolHandlers.filesystem_list!(
      { id: "tool_filesystem_list_empty_visible", type: "function", function: { name: "filesystem_list", arguments: "{\"path\":\"docs/readme.md\"}" } },
      { path: "docs/readme.md" },
      {
        debugSnapshot: {
          visibleToolNames: []
        },
        localFileService: {
          async statItem(path: string) {
            return {
              path,
              name: "readme.md",
              kind: "file",
              sizeBytes: 42,
              updatedAtMs: 123
            };
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.deepEqual(
      payload.handle_capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
      [["read_text", false], ["send_to_chat", false]]
    );
    assert.equal(payload.next_actions, undefined);
  });

function policyShape(policy: any) {
  return {
    preserveRecentRawCount: policy?.preserveRecentRawCount ?? null,
    compactorNames: Object.keys(policy?.compactors ?? {}).sort(),
    hasResource: typeof policy?.resource === "function",
    hasRefetchHint: typeof policy?.refetchHint === "function"
  };
}

  test("terminal_run forwards resource description", async () => {
    const result = await shellToolHandlers.terminal_run!(
      { id: "tool_terminal_run_1", type: "function", function: { name: "terminal_run", arguments: "{\"command\":\"pwd\",\"description\":\"确认当前目录\"}" } },
      { command: "pwd", description: "确认当前目录" },
      {
        relationship: "owner",
        shellRuntime: {
          async run(input: any) {
            assert.equal(input.command, "pwd");
            assert.equal(input.description, "确认当前目录");
            return {
              output: "/tmp\n",
              status: "completed",
              exitCode: 0,
              signal: null
            };
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.status, "completed");
  });

  test("terminal_start returns background follow-up guidance", async () => {
    const runCalls: any[] = [];
    const context = {
      relationship: "owner",
      lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
      shellRuntime: {
        async run(input: any) {
          runCalls.push(input);
          return { status: "running", resourceId: "res_shell_1" };
        }
      }
    } as any;

    const startResult = await shellToolHandlers.terminal_start!(
      { id: "tool_terminal_start_1", type: "function", function: { name: "terminal_start", arguments: "{}" } },
      { command: "npm run dev", description: "开发服务器" },
      context
    );

    const startPayload = JSON.parse(String(startResult));
    assert.equal(startPayload.status, "running");
    assert.equal(startPayload.notify_policy, "notify_on_input_and_close");
    assert.equal(startPayload.background_followup.will_trigger_on_close, true);
    assert.equal(startPayload.background_followup.will_trigger_on_input, true);
    assert.match(startPayload.background_followup.message, /自动作为内部回调再次触发/);
    assert.equal(runCalls[0].background, true);
    assert.equal(runCalls[0].description, "开发服务器");
    assert.equal(runCalls[0].notifyPolicy, "notify_on_input_and_close");
  });

  test("terminal_key and terminal_signal cover background controls", async () => {
    const interactCalls: any[] = [];
    const signalCalls: any[] = [];
    const context = {
      relationship: "owner",
      shellRuntime: {
        async interact(resourceId: string, input: string) {
          interactCalls.push({ resourceId, input });
          return { output: "", session: { resource_id: resourceId, status: "active", outputTail: "" } };
        },
        async signal(resourceId: string, signal: string) {
          signalCalls.push({ resourceId, signal });
          return { ok: true, resource_id: resourceId, signal };
        }
      }
    } as any;

    await shellToolHandlers.terminal_key!(
      { id: "tool_terminal_key_1", type: "function", function: { name: "terminal_key", arguments: "{}" } },
      { resource_id: "res_shell_1", key: "ctrl_c" },
      context
    );
    await shellToolHandlers.terminal_signal!(
      { id: "tool_terminal_signal_1", type: "function", function: { name: "terminal_signal", arguments: "{}" } },
      { resource_id: "res_shell_1", signal: "SIGKILL" },
      context
    );

    assert.deepEqual(interactCalls[0], { resourceId: "res_shell_1", input: "\u0003" });
    assert.deepEqual(signalCalls[0], { resourceId: "res_shell_1", signal: "SIGKILL" });
  });

  test("terminal_key sends semantic tmux key queues in order", async () => {
    const interactCalls: any[] = [];
    const result = await shellToolHandlers.terminal_key!(
      { id: "tool_terminal_key_queue_1", type: "function", function: { name: "terminal_key", arguments: "{}" } },
      {
        resource_id: "res_shell_1",
        keys: ["ctrl_c", "tmux_split_right", "tmux_zoom_pane", "tmux_detach"]
      },
      {
        relationship: "owner",
        shellRuntime: {
          async interact(resourceId: string, input: string) {
            interactCalls.push({ resourceId, input });
            return { output: "ok", session: { resource_id: resourceId, status: "active", outputTail: "" } };
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.output, "ok");
    assert.deepEqual(interactCalls, [{
      resourceId: "res_shell_1",
      input: "\u0003\u0002%\u0002z\u0002d"
    }]);
  });

  test("terminal_key rejects plain text inside key queues", async () => {
    const result = await shellToolHandlers.terminal_key!(
      { id: "tool_terminal_key_queue_2", type: "function", function: { name: "terminal_key", arguments: "{}" } },
      { resource_id: "res_shell_1", keys: ["tmux_command_prompt", "kill-pane"] },
      {
        relationship: "owner",
        shellRuntime: {
          async interact() {
            throw new Error("should not send invalid key queue");
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.error, "unsupported key: kill-pane");
  });

  test("terminal_list returns shell resources", async () => {
    const result = await shellToolHandlers.terminal_list!(
      { id: "tool_terminal_list_1", type: "function", function: { name: "terminal_list", arguments: "{}" } },
      {},
      {
        relationship: "owner",
        config: createForwardFeatureConfig(),
        shellRuntime: {
          async listSessionResources() {
            return [{
              resource_id: "res_shell_1",
              status: "active",
              command: "pwd",
              cwd: "/tmp",
              shell: "/bin/sh",
              login: true,
              tty: true,
              title: "pwd @ /tmp",
              description: "查看当前工作目录",
              summary: "pwd (cwd=/tmp)",
              createdAtMs: 1,
              lastAccessedAtMs: 2,
              expiresAtMs: null
            }];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.ok, true);
    assert.equal(payload.terminals[0].resource_id, "res_shell_1");
  });

  test("dump_debug_literals pushes one literal per outbound message without writing history", async () => {
    const sentMetaCalls: any[] = [];
    const sentMessages: any[] = [];
    const result = await debugToolHandlers.dump_debug_literals!(
      { id: "tool_debug_dump_1", type: "function", function: { name: "dump_debug_literals", arguments: "{\"literals\":[\"full_system_prompt\",\"persona\"]}" } },
      { literals: ["full_system_prompt", "persona"] },
      {
        relationship: "owner",
        replyDelivery: "onebot",
        lastMessage: { sessionId: "qqbot:p:2254600711", userId: "owner", senderName: "Owner" },
        debugSnapshot: {
          sessionId: "qqbot:p:2254600711",
          systemMessages: ["system prompt"],
          visibleToolNames: [],
          activeToolsets: [],
          historySummary: null,
          recentHistory: [],
          currentBatch: [],
          liveResources: [],
          debugMarkers: [],
          toolTranscript: [],
          persona: { name: "Test Persona" },
          globalRules: [],
          toolsetRules: [],
          currentUser: null,
          participantProfiles: [],
          imageCaptions: [],
          lastLlmUsage: null
        },
        oneBotClient: {
          async sendText(params: { userId?: string; groupId?: string; text: string }) {
            sentMessages.push(params);
            return { status: "ok", retcode: 0, data: { message_id: sentMessages.length } };
          }
        },
        sessionManager: {
          recordSentMessage(_sessionId: string, message: unknown) {
            sentMetaCalls.push({ kind: "sent", message });
          },
          appendDebugMarker(_sessionId: string, marker: unknown) {
            sentMetaCalls.push({ kind: "marker", marker });
          },
          getDebugMarkers() {
            return [];
          },
          getSessionView() {
            return { lastLlmUsage: null, internalTranscript: [] };
          }
        },
        personaStore: {
          async get() {
            return { name: "Test Persona" };
          }
        }
      } as any
    );

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[0], { userId: "2254600711", text: "system prompt" });
    assert.match(sentMessages[1].text, /Test Persona/);
    assert.equal(sentMetaCalls.length, 3);
    assert.equal(sentMetaCalls[2].kind, "marker");
    assert.equal((result as any).terminalResponse?.text, "");
  });

  test("asset_send_to_chat rejects text when sending an image", async () => {
    const result = await chatFileToolHandlers.asset_send_to_chat!(
      { id: "tool_workspace_send_text_reject", type: "function", function: { name: "asset_send_to_chat", arguments: "{\"file_id\":\"file_img_1\",\"text\":\"发你了\"}" } },
      { asset_ref: "img_deadbeef.png", text: "发你了" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "img_deadbeef.png" && id !== "file_img_1") {
              return null;
            }
            return {
              fileId: "file_img_1",
              fileRef: "img_deadbeef.png",
              kind: "image",
              sourceName: "test.png",
              chatFilePath: "workspace/media/file_img_1.png"
            };
          },
          async listFiles() {
            return [];
          }
        }
      } as any
    );

    assert.deepEqual(JSON.parse(String(result)), {
      error: "asset_send_to_chat 发送图片时不能附带 text"
    });
  });

  test("asset_send_to_chat sends a pure image and keeps the turn open", async () => {
    const sentMessages: any[] = [];
    const sentMetaCalls: any[] = [];
    const transcriptCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-"));
    const imagePath = join(tempDir, "test.png");
    const imageBytes = Buffer.from("fake-image-bytes");
    await writeFile(imagePath, imageBytes);

    try {
    const result = await chatFileToolHandlers.asset_send_to_chat!(
      { id: "tool_workspace_send_1", type: "function", function: { name: "asset_send_to_chat", arguments: "{\"asset_ref\":\"img_deadbeef.png\"}" } },
      { asset_ref: "img_deadbeef.png" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "img_deadbeef.png" && id !== "file_img_1") {
              return null;
            }
            return {
              fileId: "file_img_1",
              fileRef: "img_deadbeef.png",
              kind: "image",
              sourceName: "test.png",
              chatFilePath: "workspace/media/file_img_1.png"
            };
          },
          async listFiles() {
            return [];
          },
          async resolveAbsolutePath() {
            return imagePath;
          }
        },
        oneBotClient: {
          async sendMessage(params: unknown) {
            sentMessages.push(params);
            return { status: "ok", retcode: 0, data: { message_id: 42 } };
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> }) {
            queuedTasks.push(params.send);
          }
        },
        sessionManager: {
          recordSentMessage(_sessionId: string, message: unknown) {
            sentMetaCalls.push(message);
          },
          appendInternalTranscript(_sessionId: string, item: unknown) {
            transcriptCalls.push(item);
          }
        }
      } as any
    );

    assert.equal(queuedTasks.length, 1);
    assert.equal(sentMessages.length, 0);
    assert.equal(sentMetaCalls.length, 0);
    assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
      ok: true,
      asset_ref: "img_deadbeef.png",
      file_id: "file_img_1",
      deliveredAs: "image",
      queued: true
    });

    await queuedTasks[0]!();

    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0], {
      userId: "owner",
      message: [
        { type: "image", data: { file: `base64://${imageBytes.toString("base64")}` } }
      ]
    });
    assert.deepEqual(sentMetaCalls[0], {
      messageId: 42,
      text: "img_deadbeef.png",
      sentAt: sentMetaCalls[0].sentAt
    });
    assert.deepEqual(transcriptCalls[0], {
      kind: "outbound_media_message",
      llmVisible: false,
      role: "assistant",
      delivery: "onebot",
      mediaKind: "image",
      fileId: "file_img_1",
      fileRef: "img_deadbeef.png",
      sourceName: "test.png",
      chatFilePath: "workspace/media/file_img_1.png",
      sourcePath: null,
      messageId: 42,
      toolName: "asset_send_to_chat",
      captionText: null,
      timestampMs: transcriptCalls[0].timestampMs
    });
    assert.equal(typeof transcriptCalls[0].timestampMs, "number");
    assert.equal(typeof sentMetaCalls[0].sentAt, "number");
    assert.equal((result as any).terminalResponse, undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset_send_to_chat keeps the turn open for non-image fallback sends", async () => {
    const sentTexts: any[] = [];
    const sentMetaCalls: any[] = [];
    const assistantHistoryCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const result = await chatFileToolHandlers.asset_send_to_chat!(
      { id: "tool_workspace_send_2", type: "function", function: { name: "asset_send_to_chat", arguments: "{\"asset_ref\":\"file_bead1234.txt\"}" } },
      { asset_ref: "file_bead1234.txt" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "file_bead1234.txt" && id !== "file_file_1") {
              return null;
            }
            return {
              fileId: "file_file_1",
              fileRef: "file_bead1234.txt",
              kind: "file",
              sourceName: "note.txt",
              chatFilePath: "workspace/media/file_file_1.txt"
            };
          },
          async listFiles() {
            return [];
          }
        },
        oneBotClient: {
          async sendText(params: unknown) {
            sentTexts.push(params);
            return { status: "ok", retcode: 0, data: { message_id: 43 } };
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> }) {
            queuedTasks.push(params.send);
          }
        },
        sessionManager: {
          recordSentMessage(_sessionId: string, message: unknown) {
            sentMetaCalls.push(message);
          },
          appendAssistantHistory(_sessionId: string, message: unknown) {
            assistantHistoryCalls.push(message);
          }
        }
      } as any
    );

    assert.equal(queuedTasks.length, 1);
    assert.equal(sentTexts.length, 0);
    assert.equal(sentMetaCalls.length, 0);
    assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
      ok: true,
      asset_ref: "file_bead1234.txt",
      file_id: "file_file_1",
      deliveredAs: "text_fallback",
      queued: true
    });

    await queuedTasks[0]!();

    assert.equal(sentTexts.length, 1);
    assert.deepEqual(sentTexts[0], {
      userId: "owner",
      text: "asset 已发送：file_bead1234.txt；asset_id=file_file_1"
    });
    assert.deepEqual(sentMetaCalls[0], {
      messageId: 43,
      text: "asset 已发送：file_bead1234.txt；asset_id=file_file_1",
      sentAt: sentMetaCalls[0].sentAt
    });
    assert.deepEqual(assistantHistoryCalls[0], {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "asset 已发送：file_bead1234.txt；asset_id=file_file_1",
      deliveryRef: {
        platform: "onebot",
        messageId: 43
      }
    });
    assert.equal(typeof sentMetaCalls[0].sentAt, "number");
    assert.equal((result as any).terminalResponse, undefined);
  });

  test("asset_send_to_chat mirrors non-image fallback text into web delivery", async () => {
    const webChunks: string[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const assistantHistoryCalls: any[] = [];

    const result = await chatFileToolHandlers.asset_send_to_chat!(
      { id: "tool_workspace_send_2_web", type: "function", function: { name: "asset_send_to_chat", arguments: "{\"asset_ref\":\"file_bead1234.txt\"}" } },
      { asset_ref: "file_bead1234.txt" },
      {
        replyDelivery: "web",
        committedTextSink: {
          commitText(chunk: string) {
            webChunks.push(chunk);
          }
        },
        lastMessage: { sessionId: "web:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "file_bead1234.txt" && id !== "file_file_1") {
              return null;
            }
            return {
              fileId: "file_file_1",
              fileRef: "file_bead1234.txt",
              kind: "file",
              sourceName: "note.txt",
              chatFilePath: "workspace/media/file_file_1.txt"
            };
          },
          async listFiles() {
            return [];
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> }) {
            queuedTasks.push(params.send);
          }
        },
        sessionManager: {
          appendAssistantHistory(_sessionId: string, message: unknown) {
            assistantHistoryCalls.push(message);
          }
        }
      } as any
    );

    assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
      ok: true,
      asset_ref: "file_bead1234.txt",
      file_id: "file_file_1",
      deliveredAs: "text_fallback",
      queued: true
    });
    assert.equal(queuedTasks.length, 1);

    await queuedTasks[0]!();

    assert.deepEqual(webChunks, ["asset 已发送：file_bead1234.txt；asset_id=file_file_1"]);
    assert.deepEqual(assistantHistoryCalls, [{
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "asset 已发送：file_bead1234.txt；asset_id=file_file_1"
    }]);
  });

  test("asset_send_to_chat records image sends for web delivery", async () => {
    const transcriptCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-web-"));
    const imagePath = join(tempDir, "test.png");
    await writeFile(imagePath, Buffer.from("fake-image-bytes"));

    try {
      const result = await chatFileToolHandlers.asset_send_to_chat!(
        { id: "tool_workspace_send_web_img", type: "function", function: { name: "asset_send_to_chat", arguments: "{\"asset_ref\":\"img_deadbeef.png\"}" } },
        { asset_ref: "img_deadbeef.png" },
        {
          replyDelivery: "web",
          lastMessage: { sessionId: "web:owner", userId: "owner", senderName: "Owner" },
          chatFileStore: {
            async getFile(id: string) {
              if (id !== "img_deadbeef.png" && id !== "file_img_1") {
                return null;
              }
              return {
                fileId: "file_img_1",
                fileRef: "img_deadbeef.png",
                kind: "image",
                sourceName: "test.png",
                chatFilePath: "workspace/media/file_img_1.png"
              };
            },
            async listFiles() {
              return [];
            },
            async resolveAbsolutePath() {
              return imagePath;
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            appendInternalTranscript(_sessionId: string, item: unknown) {
              transcriptCalls.push(item);
            }
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        asset_ref: "img_deadbeef.png",
        file_id: "file_img_1",
        deliveredAs: "image",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);

      await queuedTasks[0]!();

      assert.deepEqual(transcriptCalls[0], {
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "web",
        mediaKind: "image",
        fileId: "file_img_1",
        fileRef: "img_deadbeef.png",
        sourceName: "test.png",
        chatFilePath: "workspace/media/file_img_1.png",
        sourcePath: null,
        messageId: null,
        toolName: "asset_send_to_chat",
        captionText: null,
        timestampMs: transcriptCalls[0].timestampMs
      });
      assert.equal(typeof transcriptCalls[0].timestampMs, "number");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset_send_to_chat accepts stored filenames as asset_ref", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-ref-"));
    const imagePath = join(tempDir, "file_deadbeef.jpg");
    await writeFile(imagePath, Buffer.from("fake-image-bytes"));
    const queuedTasks: Array<() => Promise<void>> = [];
    const sentMessages: any[] = [];
    try {
      const result = await chatFileToolHandlers.asset_send_to_chat!(
        { id: "tool_workspace_send_3", type: "function", function: { name: "asset_send_to_chat", arguments: "{\"asset_ref\":\"file_deadbeef.jpg\"}" } },
        { asset_ref: "file_deadbeef.jpg" },
        {
          lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
          chatFileStore: {
            async getFile(id: string) {
              if (id === "file_deadbeef") {
                return {
                  fileId: "file_deadbeef",
                  fileRef: "img_deadbeef.jpg",
                  kind: "image",
                  origin: "local_file_import",
                  chatFilePath: "workspace/media/file_deadbeef.jpg",
                  sourceName: "photo.jpg",
                  mimeType: "image/jpeg",
                  sizeBytes: 123,
                  createdAtMs: 1,
                  sourceContext: {},
                  caption: null
                };
              }
              return null;
            },
            async listFiles() {
              return [{
                fileId: "file_deadbeef",
                fileRef: "img_deadbeef.jpg",
                kind: "image",
                origin: "local_file_import",
                chatFilePath: "workspace/media/file_deadbeef.jpg",
                sourceName: "photo.jpg",
                mimeType: "image/jpeg",
                sizeBytes: 123,
                createdAtMs: 1,
                sourceContext: {},
                caption: null
              }];
            },
            async resolveAbsolutePath() {
              return imagePath;
            }
          },
          oneBotClient: {
            async sendMessage(params: unknown) {
              sentMessages.push(params);
              return { status: "ok", retcode: 0, data: { message_id: 99 } };
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            recordSentMessage() {},
            appendInternalTranscript() {}
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        asset_ref: "img_deadbeef.jpg",
        file_id: "file_deadbeef",
        deliveredAs: "image",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);
      assert.equal(sentMessages.length, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("filesystem_send_to_chat sends workspace-relative image", async () => {
    const queuedTasks: Array<() => Promise<void>> = [];
    const sentMessages: any[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-path-rel-"));
    const imagePath = join(tempDir, "diagram.png");
    const imageBytes = Buffer.from("fake-image-bytes");
    await writeFile(imagePath, imageBytes);

    try {
      const result = await localFileToolHandlers.filesystem_send_to_chat!(
        { id: "tool_workspace_send_path_rel", type: "function", function: { name: "filesystem_send_to_chat", arguments: "{\"path\":\"outputs/diagram.png\"}" } },
        { path: "outputs/diagram.png" },
        {
          config: createTestAppConfig(),
          lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
          localFileService: {
            resolvePath(relativePath: string) {
              assert.equal(relativePath, "outputs/diagram.png");
              return {
                relativePath: "outputs/diagram.png",
                absolutePath: imagePath
              };
            }
          },
          chatFileStore: {
            async resolveAbsolutePath() {
              throw new Error("should not be called");
            }
          },
          oneBotClient: {
            async sendMessage(params: unknown) {
              sentMessages.push(params);
              return { status: "ok", retcode: 0, data: { message_id: 55 } };
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            recordSentMessage() {},
            appendInternalTranscript() {}
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        path: "outputs/diagram.png",
        path_mode: "workspace_relative",
        deliveredAs: "image",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);

      await queuedTasks[0]!();

      assert.deepEqual(sentMessages[0], {
        userId: "owner",
        message: [
          { type: "image", data: { file: `base64://${imageBytes.toString("base64")}` } }
        ]
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("filesystem_send_to_chat sends file via absolute path", async () => {
    const queuedTasks: Array<() => Promise<void>> = [];
    const sentTexts: any[] = [];
    const assistantHistoryCalls: any[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-path-abs-"));
    const filePath = join(tempDir, "report.txt");
    await writeFile(filePath, "hello", "utf8");

    try {
      const result = await localFileToolHandlers.filesystem_send_to_chat!(
        { id: "tool_workspace_send_path_abs", type: "function", function: { name: "filesystem_send_to_chat", arguments: `{\"path\":\"${filePath}\"}` } },
        { path: filePath },
        {
          config: createTestAppConfig(),
          localFileService: {
            resolvePath(path: string) {
              return { relativePath: path, absolutePath: path };
            }
          },
          lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
          oneBotClient: {
            async sendText(params: unknown) {
              sentTexts.push(params);
              return { status: "ok", retcode: 0, data: { message_id: 77 } };
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            recordSentMessage() {},
            appendAssistantHistory(_sessionId: string, message: unknown) {
              assistantHistoryCalls.push(message);
            }
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        path: filePath,
        path_mode: "absolute",
        deliveredAs: "text_fallback",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);

      await queuedTasks[0]!();

      assert.deepEqual(sentTexts[0], {
        userId: "owner",
        text: `文件已发送：${filePath}`
      });
      assert.deepEqual(assistantHistoryCalls[0], {
        chatType: "private",
        userId: "owner",
        senderName: "Owner",
        text: `文件已发送：${filePath}`,
        deliveryRef: {
          platform: "onebot",
          messageId: 77
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("filesystem_send_to_chat resolves relative path through localFileService", async () => {
    const result = await localFileToolHandlers.filesystem_send_to_chat!(
      { id: "tool_workspace_send_path_rel_resolve", type: "function", function: { name: "filesystem_send_to_chat", arguments: "{\"path\":\"outputs/demo.txt\"}" } },
      { path: "outputs/demo.txt" },
      {
        config: createTestAppConfig(),
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        localFileService: {
          resolvePath(relativePath: string) {
            assert.equal(relativePath, "outputs/demo.txt");
            return {
              relativePath,
              absolutePath: "/project/data/outputs/demo.txt"
            };
          }
        },
        messageQueue: {
          enqueueTextDetached() {}
        }
      } as any
    );

    assert.equal(JSON.parse(String((result as any).content ?? result)).path, "outputs/demo.txt");
  });

  test("list_live_resources returns browser resources only", async () => {
    const result = await resourceToolHandlers.list_live_resources!(
      { id: "tool_resource_list_1", type: "function", function: { name: "list_live_resources", arguments: "{}" } },
      {},
      {
        config: createForwardFeatureConfig(),
        browserService: {
          async listPages() {
            return {
              ok: true,
              pages: [{
                resource_id: "res_browser_1",
                status: "active",
                title: "OpenAI",
                description: "查看首页文案",
                summary: "OpenAI",
                requestedUrl: "https://openai.com",
                resolvedUrl: "https://openai.com",
                backend: "playwright",
                profile_id: null,
                createdAtMs: 1,
                lastAccessedAtMs: 10,
                expiresAtMs: 100
              }]
            };
          }
        },
        downloadRuntime: {
          list() {
            return [];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.live_resources.map((item: any) => item.resource_id), ["res_browser_1"]);
    assert.equal(payload.live_resources[0].description, "查看首页文案");
  });

  test("list_live_resources only returns valid active resources", async () => {
    const result = await resourceToolHandlers.list_live_resources!(
      { id: "tool_resource_list_2", type: "function", function: { name: "list_live_resources", arguments: "{}" } },
      {},
      {
        config: createForwardFeatureConfig(),
        browserService: {
          async listPages() {
            return {
              ok: true,
              pages: [{
                resource_id: "res_browser_live",
                status: "active",
                title: "Live page",
                description: "继续支付流程",
                summary: "Live page",
                requestedUrl: "https://example.com/live",
                resolvedUrl: "https://example.com/live",
                backend: "playwright",
                profile_id: null,
                createdAtMs: 1,
                lastAccessedAtMs: 3,
                expiresAtMs: 100
              }]
            };
          }
        },
        downloadRuntime: {
          list() {
            return [];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.deepEqual(payload.live_resources.map((item: any) => item.resource_id), ["res_browser_live"]);
    assert.equal(payload.live_resources.every((item: any) => item.status === "active"), true);
    assert.equal(payload.live_resources[0].description, "继续支付流程");
  });

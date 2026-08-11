import test from "node:test";
import assert from "node:assert/strict";
import {
  listConfigurableSessionToolsets,
  listTurnToolsets,
  resolveToolNamesFromToolsets
} from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { resolveSessionToolsetEnabled } from "../../src/conversation/session/sessionToolsetPreferences.ts";
import { TOOLSET_DEFINITIONS } from "../../src/llm/tools/toolsetCatalog.ts";
import { decideToolsetSupplements } from "../../src/app/generation/toolsetSupplementPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { requireSessionModeDefinition } from "../../src/modes/registry.ts";
import { resolveSessionModeSetupContext } from "../../src/app/generation/generationSetupContext.ts";
import { createScenarioHostSetupToolsetOverrides } from "../../src/modes/scenarioHost/setupToolsets.ts";

function createMediaToolsetConfig(options: { mainSupportsVision: boolean }) {
  return createTestAppConfig({
    llm: {
      models: {
        main: {
          supportsVision: options.mainSupportsVision
        },
        inspector: {
          provider: "test",
          model: "fake-inspector",
          supportsThinking: false,
          thinkingControllable: true,
          supportsVision: true,
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
          sessionCaptioner: ["sessionCaptioner"],
          imageCaptioner: ["main"],
          imageInspector: ["inspector"],
          audioTranscription: ["transcription"],
          turnPlanner: ["main"]
        }
      }
    }
  });
}

  test("setup overrides keep shared toolsets while replacing overridden ids", async () => {
    const config = createTestAppConfig({
      browser: { enabled: true, playwright: { enabled: true } },
      shell: { enabled: true }
    });
    const toolsets = listTurnToolsets({
      config,
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      setupPhase: {
        setupToolsetOverrides: [
          {
            toolsetId: "memory_profile",
            title: "初始化资料",
            description: "仅初始化 persona",
            toolNames: ["get_persona", "patch_persona"]
          }
        ]
      },
      modeId: "rp_assistant"
    });

    const memoryProfile = toolsets.find((item) => item.id === "memory_profile");
    assert.deepEqual(memoryProfile?.toolNames, ["get_persona", "patch_persona"]);
    assert.equal(toolsets.some((item) => item.id === "chat_context"), true);
    assert.equal(toolsets.some((item) => item.id === "web_research"), false);
    assert.equal(toolsets.some((item) => item.id === "shell_runtime"), false);
  });

  test("mode defaults still scope non-universal toolsets", async () => {
    const config = createTestAppConfig();
    const toolsets = listTurnToolsets({
      config,
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "scenario_host"
    });

    assert.equal(toolsets.some((item) => item.id === "scenario_host_state"), true);
    assert.equal(
      toolsets.find((item) => item.id === "scenario_host_state")?.toolNames.includes("set_scenario_setup_optional_item_status"),
      false
    );
    assert.equal(toolsets.some((item) => item.id === "memory_profile"), false);
    assert.deepEqual(
      resolveToolNamesFromToolsets(toolsets, ["scenario_host_state", "time_utils"]).includes("get_current_time"),
      true
    );
  });

  test("session boundary removes disabled toolsets from planner candidates and model tools", () => {
    const config = createTestAppConfig({
      browser: { enabled: true, playwright: { enabled: true } }
    });
    const toolsets = listTurnToolsets({
      config,
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "assistant",
      toolsetPreferences: {
        overrides: { web_research: "disabled" }
      }
    });

    assert.equal(toolsets.some((item) => item.id === "web_research"), false);
    assert.equal(resolveToolNamesFromToolsets(toolsets, ["web_research"]).length, 0);
    assert.equal(
      listConfigurableSessionToolsets("assistant", {
        overrides: { web_research: "disabled" }
      }).find((item) => item.id === "web_research")?.effectiveEnabled,
      false
    );
  });

  test("sparse session overrides preserve catalog defaults, including future opt-in toolsets", () => {
    const emptyPreferences = { overrides: {} };
    assert.equal(resolveSessionToolsetEnabled(emptyPreferences, "future_opt_in", false), false);
    assert.equal(resolveSessionToolsetEnabled(emptyPreferences, "future_default", true), true);
    assert.equal(resolveSessionToolsetEnabled({
      overrides: { future_opt_in: "enabled", future_default: "disabled" }
    }, "future_opt_in", false), true);
    assert.equal(resolveSessionToolsetEnabled({
      overrides: { future_opt_in: "enabled", future_default: "disabled" }
    }, "future_default", true), false);
  });

  test("setup-required toolsets bypass the normal session boundary", () => {
    const toolsets = listTurnToolsets({
      config: createTestAppConfig(),
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "rp_assistant",
      toolsetPreferences: {
        overrides: { memory_profile: "disabled" }
      },
      setupPhase: {
        setupToolsetOverrides: [{
          toolsetId: "memory_profile",
          title: "初始化资料",
          toolNames: ["get_persona", "patch_persona"]
        }]
      }
    });

    assert.deepEqual(
      toolsets.find((item) => item.id === "memory_profile")?.toolNames,
      ["get_persona", "patch_persona"]
    );
  });

  test("scenario setup exposes optional item skip status only through setup override", async () => {
    const config = createTestAppConfig();
    const toolsets = listTurnToolsets({
      config,
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "scenario_host",
      setupPhase: {
        setupToolsetOverrides: createScenarioHostSetupToolsetOverrides()
      }
    });

    assert.equal(
      toolsets.find((item) => item.id === "scenario_runtime_state_draft")?.toolNames.includes("set_scenario_setup_optional_item_status"),
      true
    );
  });

  test("chat context toolset filters current group tools by session visibility", async () => {
    const config = createTestAppConfig();
    const selectChatContextTools = (sessionId: string, replyDelivery: "onebot" | "web") => (
      listTurnToolsets({
        config,
        relationship: "owner",
        currentUser: null,
        modelRef: ["main"],
        includeDebugTools: false,
        modeId: "assistant",
        visibilityContext: { sessionId, replyDelivery }
      }).find((item) => item.id === "chat_context")?.toolNames ?? []
    );

    assert.ok(selectChatContextTools("qqbot:g:123456", "onebot").includes("view_current_group_info"));
    assert.ok(selectChatContextTools("qqbot:g:123456", "onebot").includes("view_current_group_announcement"));
    assert.ok(selectChatContextTools("qqbot:g:123456", "onebot").includes("list_current_group_files"));
    assert.ok(selectChatContextTools("qqbot:g:123456", "onebot").includes("download_current_group_file"));
    assert.ok(!selectChatContextTools("qqbot:p:10001", "onebot").includes("view_current_group_info"));
    assert.ok(!selectChatContextTools("qqbot:p:10001", "onebot").includes("view_current_group_announcement"));
    assert.ok(!selectChatContextTools("qqbot:p:10001", "onebot").includes("list_current_group_files"));
    assert.ok(!selectChatContextTools("qqbot:p:10001", "onebot").includes("download_current_group_file"));
    assert.ok(!selectChatContextTools("web:panel", "web").includes("view_current_group_info"));
    assert.ok(!selectChatContextTools("qqbot:g:123456", "web").includes("view_current_group_info"));
  });

  test("assistant mode defaults to local functional toolsets only", async () => {
    const config = createTestAppConfig({
      browser: { enabled: true, playwright: { enabled: true } },
      shell: { enabled: true }
    });
    const toolsets = listTurnToolsets({
      config,
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "assistant"
    });

    assert.equal(
      requireSessionModeDefinition("assistant").toolsets.some((item) => item.toolsetId === "comfy_image"),
      true
    );
    assert.deepEqual(toolsets.map((item) => item.id), [
      "chat_context",
      "web_research",
      "shell_runtime",
      "filesystem_io",
      "asset_io",
      "scheduler_admin",
      "time_utils",
      "dice_roller",
      "session_mode_control"
    ]);
    assert.equal(toolsets.some((item) => item.id === "memory_profile"), false);
    assert.equal(toolsets.some((item) => item.id === "conversation_navigation"), false);
    assert.equal(toolsets.some((item) => item.id === "chat_delegation"), false);
  });

  test("toolset catalog keeps browser downloads separate from local file paths", async () => {
    const webResearch = TOOLSET_DEFINITIONS.find((item) => item.id === "web_research");
    const localFileIo = TOOLSET_DEFINITIONS.find((item) => item.id === "filesystem_io");
    assert.ok(webResearch);
    assert.ok(localFileIo);

    assert.ok(webResearch.toolNames.includes("download_asset"));
    assert.ok(!localFileIo.toolNames.includes("download_asset"));
    assert.ok(localFileIo.toolNames.includes("filesystem_mkdir"));
  });

  test("media inspection tools stay next to existing media view toolsets", async () => {
    const chatContext = TOOLSET_DEFINITIONS.find((item) => item.id === "chat_context");
    const chatFileIo = TOOLSET_DEFINITIONS.find((item) => item.id === "asset_io");
    const localFileIo = TOOLSET_DEFINITIONS.find((item) => item.id === "filesystem_io");
    assert.ok(chatContext);
    assert.ok(chatFileIo);
    assert.ok(localFileIo);

    assert.ok(chatContext.toolNames.includes("asset_media_view"));
    assert.ok(chatContext.toolNames.includes("asset_media_inspect"));
    assert.ok(chatFileIo.toolNames.includes("asset_media_view"));
    assert.ok(chatFileIo.toolNames.includes("asset_media_inspect"));
    assert.ok(localFileIo.toolNames.includes("filesystem_media_view"));
    assert.ok(localFileIo.toolNames.includes("filesystem_media_inspect"));
  });

  test("media toolsets expose direct view only for vision models while keeping inspection available", async () => {
    const nonVisionToolsets = listTurnToolsets({
      config: createMediaToolsetConfig({ mainSupportsVision: false }),
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "assistant"
    });
    const nonVisionNames = new Set(nonVisionToolsets.flatMap((toolset) => toolset.toolNames));
    assert.equal(nonVisionNames.has("asset_media_view"), false);
    assert.equal(nonVisionNames.has("filesystem_media_view"), false);
    assert.equal(nonVisionNames.has("asset_media_inspect"), true);
    assert.equal(nonVisionNames.has("filesystem_media_inspect"), true);

    const visionToolsets = listTurnToolsets({
      config: createMediaToolsetConfig({ mainSupportsVision: true }),
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "assistant"
    });
    const visionNames = new Set(visionToolsets.flatMap((toolset) => toolset.toolNames));
    assert.equal(visionNames.has("asset_media_view"), true);
    assert.equal(visionNames.has("filesystem_media_view"), true);
    assert.equal(visionNames.has("asset_media_inspect"), true);
    assert.equal(visionNames.has("filesystem_media_inspect"), true);
  });

  test("rp_assistant setup prefers persona_setup before mode_setup", async () => {
    const mode = requireSessionModeDefinition("rp_assistant");
    const kind = mode.setupPhase?.resolveOperationModeKind({
      personaReady: false,
      modeProfileReady: false,
      operationMode: { kind: "normal" },
      chatType: "private",
      relationship: "owner"
    });

    assert.equal(kind, "persona_setup");
  });

  test("assistant mode requires persona_setup when global persona is not ready", async () => {
    const mode = requireSessionModeDefinition("assistant");
    const kind = mode.setupPhase?.resolveOperationModeKind({
      personaReady: false,
      modeProfileReady: true,
      operationMode: { kind: "normal" },
      chatType: "private",
      relationship: "owner"
    });

    assert.equal(kind, "persona_setup");
  });

  test("scenario_host enters mode_setup only after persona is ready", async () => {
    const mode = requireSessionModeDefinition("scenario_host");
    const kind = mode.setupPhase?.resolveOperationModeKind({
      personaReady: true,
      modeProfileReady: false,
      operationMode: { kind: "normal" },
      chatType: "private",
      relationship: "owner"
    });

    assert.equal(kind, "mode_setup");
  });

  test("setup context uses ready persona readiness before mode profile readiness", async () => {
    const ctx = await resolveSessionModeSetupContext(
      "rp_assistant",
      "qqbot:p:test",
      {
        globalProfileReadinessStore: {
          async get() {
            return {
              persona: "ready",
              rp: "uninitialized",
              updatedAt: 1
            };
          }
        } as any,
        scenarioHostStateStore: {
          async ensureForSession() {
            throw new Error("scenarioHostStateStore should not be used for rp_assistant");
          }
        } as any,
        sessionManager: {
          isSetupConfirmed() {
            return false;
          },
          getOperationMode() {
            return { kind: "normal" };
          },
          getSession() {
            throw new Error("getSession should not be used for rp_assistant");
          }
        } as any
      },
      {
        chatType: "private",
        relationship: "owner"
      }
    );

    assert.equal(ctx.personaReady, true);
    assert.equal(ctx.modeProfileReady, false);
    assert.equal(
      requireSessionModeDefinition("rp_assistant").setupPhase?.resolveOperationModeKind(ctx),
      "mode_setup"
    );
  });

  test("supplement policy stays auditable and ordered by available toolsets", async () => {
    const decisions = decideToolsetSupplements({
      selectedToolsetIds: ["web_research"],
      availableToolsetIds: ["chat_context", "web_research", "filesystem_io", "shell_runtime"],
      signals: {
        requiredCapabilities: ["filesystem_access"],
        contextDependencies: ["structured_message_context"],
        recentDomainReuse: [],
        followupMode: "elliptical",
        recentDomains: {
          hasWeb: true,
          hasShell: false,
          hasLocalFiles: false,
          hasChatContext: false
        }
      }
    });

    assert.deepEqual(decisions, [
      { toolsetId: "filesystem_io", reason: "planner_filesystem_access" }
    ]);
  });

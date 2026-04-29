import test from "node:test";
import assert from "node:assert/strict";
import { listTurnToolsets, resolveToolNamesFromToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { TOOLSET_DEFINITIONS } from "../../src/llm/tools/toolsetCatalog.ts";
import { decideToolsetSupplements } from "../../src/app/generation/toolsetSupplementPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { requireSessionModeDefinition } from "../../src/modes/registry.ts";
import { resolveSessionModeSetupContext } from "../../src/app/generation/generationSetupContext.ts";

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
    assert.equal(toolsets.some((item) => item.id === "memory_profile"), false);
    assert.deepEqual(
      resolveToolNamesFromToolsets(toolsets, ["scenario_host_state", "time_utils"]).includes("get_current_time"),
      true
    );
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

    assert.equal(requireSessionModeDefinition("assistant").defaultToolsetIds.includes("comfy_image"), true);
    assert.deepEqual(toolsets.map((item) => item.id), [
      "chat_context",
      "web_research",
      "shell_runtime",
      "local_file_io",
      "chat_file_io",
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
    const localFileIo = TOOLSET_DEFINITIONS.find((item) => item.id === "local_file_io");
    assert.ok(webResearch);
    assert.ok(localFileIo);

    assert.ok(webResearch.toolNames.includes("download_asset"));
    assert.ok(!localFileIo.toolNames.includes("download_asset"));
    assert.ok(localFileIo.toolNames.includes("local_file_mkdir"));
    assert.equal(
      localFileIo.promptGuidance?.some((line) => /下载网页资源/.test(line)),
      false
    );
  });

  test("media inspection tools stay next to existing media view toolsets", async () => {
    const chatContext = TOOLSET_DEFINITIONS.find((item) => item.id === "chat_context");
    const chatFileIo = TOOLSET_DEFINITIONS.find((item) => item.id === "chat_file_io");
    const localFileIo = TOOLSET_DEFINITIONS.find((item) => item.id === "local_file_io");
    assert.ok(chatContext);
    assert.ok(chatFileIo);
    assert.ok(localFileIo);

    assert.ok(chatContext.toolNames.includes("chat_file_view_media"));
    assert.ok(chatContext.toolNames.includes("chat_file_inspect_media"));
    assert.ok(chatFileIo.toolNames.includes("chat_file_view_media"));
    assert.ok(chatFileIo.toolNames.includes("chat_file_inspect_media"));
    assert.ok(localFileIo.toolNames.includes("local_file_view_media"));
    assert.ok(localFileIo.toolNames.includes("local_file_inspect_media"));
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
    assert.equal(nonVisionNames.has("chat_file_view_media"), false);
    assert.equal(nonVisionNames.has("local_file_view_media"), false);
    assert.equal(nonVisionNames.has("chat_file_inspect_media"), true);
    assert.equal(nonVisionNames.has("local_file_inspect_media"), true);

    const visionToolsets = listTurnToolsets({
      config: createMediaToolsetConfig({ mainSupportsVision: true }),
      relationship: "owner",
      currentUser: null,
      modelRef: ["main"],
      includeDebugTools: false,
      modeId: "assistant"
    });
    const visionNames = new Set(visionToolsets.flatMap((toolset) => toolset.toolNames));
    assert.equal(visionNames.has("chat_file_view_media"), true);
    assert.equal(visionNames.has("local_file_view_media"), true);
    assert.equal(visionNames.has("chat_file_inspect_media"), true);
    assert.equal(visionNames.has("local_file_inspect_media"), true);
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
              scenario: "uninitialized",
              updatedAt: 1
            };
          }
        } as any,
        sessionManager: {
          isSetupConfirmed() {
            return false;
          },
          getOperationMode() {
            return { kind: "normal" };
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
      availableToolsetIds: ["chat_context", "web_research", "local_file_io", "shell_runtime"],
      signals: {
        hasStructuredResolvableContent: true,
        requiredCapabilities: ["local_file_access"],
        contextDependencies: ["structured_message_context"],
        recentDomainReuse: [],
        followupMode: "elliptical",
        recentDomains: {
          hasWeb: true,
          hasShell: false,
          hasLocalFiles: false,
          hasChatContext: false
        },
        hasDiceRollSignal: false
      }
    });

    assert.deepEqual(decisions, [
      { toolsetId: "chat_context", reason: "structured_content" },
      { toolsetId: "local_file_io", reason: "planner_local_file_access" }
    ]);
  });

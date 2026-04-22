import test from "node:test";
import assert from "node:assert/strict";
import { listTurnToolsets, resolveToolNamesFromToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { decideToolsetSupplements } from "../../src/app/generation/toolsetSupplementPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { requireSessionModeDefinition } from "../../src/modes/registry.ts";

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
      "session_mode_control"
    ]);
    assert.equal(toolsets.some((item) => item.id === "memory_profile"), false);
    assert.equal(toolsets.some((item) => item.id === "conversation_navigation"), false);
    assert.equal(toolsets.some((item) => item.id === "chat_delegation"), false);
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
        }
      }
    });

    assert.deepEqual(decisions, [
      { toolsetId: "chat_context", reason: "structured_content" },
      { toolsetId: "local_file_io", reason: "planner_local_file_access" }
    ]);
  });

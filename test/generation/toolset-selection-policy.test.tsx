import assert from "node:assert/strict";
import { listTurnToolsets, resolveToolNamesFromToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { decideToolsetSupplements } from "../../src/app/generation/toolsetSupplementPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { requireSessionModeDefinition } from "../../src/modes/registry.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`- ${name} ... ok`);
  } catch (error) {
    console.error(`- ${name} ... failed`);
    throw error;
  }
}

async function main() {
  await runCase("setup overrides keep shared toolsets while replacing overridden ids", async () => {
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

  await runCase("mode defaults still scope non-universal toolsets", async () => {
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

  await runCase("assistant mode defaults to local functional toolsets only", async () => {
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

  await runCase("supplement policy stays auditable and ordered by available toolsets", async () => {
    const decisions = decideToolsetSupplements({
      selectedToolsetIds: ["web_research"],
      availableToolsetIds: ["chat_context", "web_research", "local_file_io", "shell_runtime"],
      signals: {
        hasStructuredResolvableContent: true,
        hasWebIntent: false,
        hasShellIntent: false,
        hasLocalFileIntent: false,
        hasMemoryIntent: false,
        hasSchedulerIntent: false,
        hasTimeIntent: false,
        hasSocialIntent: false,
        hasConversationNavigationIntent: false,
        hasDelegationIntent: false,
        hasComfyIntent: false,
        hasDownloadIntent: true,
        hasWebContextReference: false,
        hasFollowupReference: true,
        isEllipticalFollowup: true,
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
      { toolsetId: "local_file_io", reason: "web_download_linkage" }
    ]);
  });
}

void main();

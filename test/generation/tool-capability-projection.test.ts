import { buildToolHintLines } from "../../src/llm/prompt/promptToolHints.ts";
import { resolveSessionBoundaryToolNames } from "../../src/llm/tools/toolsetBoundary.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildChatFileHandleResult, buildLocalFileHandleResult } from "../../src/llm/tools/core/fileHandle.ts";
import { filterToolNextActions } from "../../src/llm/tools/core/toolNextActions.ts";
import { TOOLSET_DEFINITIONS, toToolsetView } from "../../src/llm/tools/toolsetCatalog.ts";
import { listConfigurableSessionToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { ChatFileRecord, LocalFileItemStat } from "../../src/services/workspace/types.ts";

test("资产动作同时受激活工具和目标媒体类型限制", () => {
  const file = { fileId: "a", fileRef: "asset://a", kind: "file", sourceName: "test.txt", mimeType: "text/plain", chatFilePath: "/tmp/test.txt" } as ChatFileRecord;
  const visibleToolNames = ["asset_send_to_chat", "asset_document_read"];
  const unsupported = buildChatFileHandleResult(file, { visibleToolNames, connectorCapabilities: new Set(["media.image.send"]) });
  assert.equal(unsupported.asset_handle.capabilities.some(item => item.capability === "send_to_chat"), false);
  assert.equal(unsupported.asset_handle.capabilities.every(item => item.available), true);
  const supported = buildChatFileHandleResult(file, { visibleToolNames, connectorCapabilities: new Set(["media.file.send"]) });
  assert.equal(supported.asset_handle.capabilities.some(item => item.capability === "send_to_chat"), true);
  assert.equal(supported.asset_handle.capabilities.some(item => item.requires?.includes("webui_or_napcat_file_upload")), false);
  const inactive = buildChatFileHandleResult(file, { visibleToolNames: [], connectorCapabilities: new Set(["media.file.send"]) });
  assert.deepEqual(inactive.asset_handle.capabilities, []);
});

test("本地普通文件发送不能借图片能力开放", () => {
  const file = { path: "/tmp/a.txt", name: "a.txt", kind: "file", sizeBytes: 1, updatedAtMs: 0 } as LocalFileItemStat;
  const result = buildLocalFileHandleResult(file, { visibleToolNames: ["filesystem_send_to_chat"], connectorCapabilities: new Set(["media.image.send"]) });
  assert.deepEqual(result.handle_capabilities, []);
  assert.equal(result.next_actions, undefined);
});

test("部分工具集不宣传已过滤操作，空集隐藏", () => {
  const definition = { id: "mixed", title: "混合能力", description: "读取群文件并投骰", plannerSignals: ["群文件"], toolNames: ["group_read", "roll_dice"] };
  assert.equal(toToolsetView(definition, new Set()), null);
  const view = toToolsetView(definition, new Set(["roll_dice"]))!;
  assert.equal(view.description.includes("群文件"), false);
  assert.deepEqual(view.plannerSignals, ["使用 roll_dice"]);
});

test("不可用工具集保留设置意图但当前不生效", () => {
  const preferences = { overrides: { social_admin: "enabled" as const } };
  const option = listConfigurableSessionToolsets("rp_assistant", preferences, { config: createTestAppConfig(), relationship: "owner", currentUser: null, visibilityContext: { sessionId: "web:test" } }).find(item => item.id === "social_admin")!;
  assert.equal(option.override, "enabled");
  assert.equal(option.available, false);
  assert.equal(option.effectiveEnabled, false);
  assert.ok(option.unavailableReason);
  assert.equal(preferences.overrides.social_admin, "enabled");
});

test("后续动作只过滤受控根层，保留用户JSON原样", () => {
  const userData = { next_actions: [{ tool: "hidden" }] };
  const result = filterToolNextActions({ userData, next_actions: [{ tool: "hidden" }, { tool: "visible" }] }, new Set(["visible"]));
  assert.deepEqual(result.next_actions, [{ tool: "visible" }]);
  assert.equal(result.userData, userData);
});


test("混合会话工具集用剩余功能片段描述，不宣传原生群接口", () => {
  const definition = TOOLSET_DEFINITIONS.find(item => item.id === "chat_context")!;
  const view = toToolsetView(definition, new Set(["view_forward_record", "asset_media_view", "asset_media_inspect", "resolve_media_reference", "end_turn_without_reply"]))!;
  assert.match(view.description, /缓存转发/);
  assert.match(view.description, /媒体/);
  assert.doesNotMatch(view.description, /群文件|群成员|群公告|原生消息/);
  assert.equal(view.plannerSignals?.some(signal => /群文件|群成员|群公告/.test(signal)), false);
});


test("初始化共享工具集遵循用户禁止，必需编辑工具不受普通边界影响", () => {
  const operationMode = { kind: "persona_setup" as const, draft: {} as never };
  const names = resolveSessionBoundaryToolNames("rp_assistant", { overrides: { time_utils: "disabled", memory_profile: "disabled" } }, operationMode);
  assert.equal(names.has("get_current_time"), false);
  assert.equal(names.has("edit_character_section"), true);
  const skill = resolveSessionBoundaryToolNames("assistant", { overrides: { asset_io: "disabled" } }, { kind: "skill_config", skillId: "test" });
  assert.equal(skill.has("asset_list"), false);
});


test("部分激活保留合法提示而不推荐隐藏发送或状态工具", () => {
  const hints = buildToolHintLines(["filesystem_read", "filesystem_media_view", "read_download_resource", "update_scenario_state", "get_scenario_state"]).join("\n");
  assert.match(hints, /filesystem_\* 处理本地文件/);
  assert.match(hints, /filesystem_media_view/);
  assert.match(hints, /read_download_resource/);
  assert.match(hints, /必须用对应场景状态工具同步状态/);
  assert.doesNotMatch(hints, /filesystem_send_to_chat|start_download_resource|manage_npc|manage_entity|append_journal_entry/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { getBuiltinToolDescriptors } from "../../src/llm/tools/toolRegistry.ts";
import { supportsWorkspace } from "../../src/llm/tools/core/filesystemScope.ts";
import {
  describeToolModelPolicy, resolveToolModelRequirement, type ToolModelPolicy
} from "../../src/llm/tools/core/toolModelPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

const config = createTestAppConfig();
config.comfy.enabled = true;
const descriptors = getBuiltinToolDescriptors(config);
const tool = (name: string) => {
  const result = descriptors.find(item => item.definition.function.name === name);
  assert.ok(result, `工具不存在：${name}`);
  return result;
};

test("all registered operations, including generated tools, declare model semantics", () => {
  assert.ok(descriptors.length > 100);
  for (const descriptor of descriptors) {
    assert.ok(descriptor.modelPolicy, descriptor.definition.function.name);
    assert.ok(describeToolModelPolicy(descriptor.modelPolicy).length > 0);
    if (descriptor.modelPolicy.kind === "filesystem") {
      assert.ok(supportsWorkspace(descriptor.definition.function.name), "工作区例外只用于实际经过作用域包装的操作");
    }
  }
  assert.ok(tool("generate_image_with_comfyui").modelPolicy);
  assert.ok(tool("workspace_extract").modelPolicy);
  assert.ok(tool("sticker_collect").modelPolicy);
  assert.ok(tool("save_skill").modelPolicy);
});

test("undeclared semantics require review, and semantic decisions do not use operation names", () => {
  assert.equal(resolveToolModelRequirement({}, {}).tier, "large");
  for (const [kind, expected] of [["observe", "small"], ["bounded_content", "small"],
    ["execution", "large"], ["persistent_policy", "large"], ["external_effect", "large"]] as const) {
    const descriptor = { modelPolicy: { kind } satisfies ToolModelPolicy, name: "future_operation" };
    assert.equal(resolveToolModelRequirement(descriptor, {}).tier, expected);
  }
});

test("host filesystem access requires large, while validated workspace paths retain their bounded scope", () => {
  for (const name of ["filesystem_read", "filesystem_search", "filesystem_patch", "filesystem_delete",
    "filesystem_media_view", "filesystem_send_to_chat", "asset_export_to_filesystem"]) {
    const descriptor = tool(name);
    assert.equal(resolveToolModelRequirement(descriptor, { path: "report.txt" }).tier, "large", name);
    assert.equal(resolveToolModelRequirement(descriptor, { workspace_id: "task-workspace", path: "report.txt" }).tier, "small", name);
    for (const workspace_id of ["", "   ", true, null]) {
      assert.equal(resolveToolModelRequirement(descriptor, { workspace_id }).tier, "large", name);
    }
  }
  const transform = tool("asset_image_transform");
  assert.equal(resolveToolModelRequirement(transform, { asset_ref: "asset:example" }).tier, "small");
  assert.equal(resolveToolModelRequirement(transform, { path: "/tmp/image.png" }).tier, "large");
  assert.equal(resolveToolModelRequirement(transform, { path: "image.png", workspace_id: "not-supported" }).tier, "large");
});

test("observing terminal state is distinct from starting or controlling an executing program", () => {
  for (const name of ["terminal_list", "terminal_read"]) {
    assert.equal(resolveToolModelRequirement(tool(name), {}).tier, "small");
  }
  for (const name of ["terminal_run", "terminal_start", "terminal_write", "terminal_send_lines",
    "terminal_key", "terminal_signal", "terminal_stop"]) {
    assert.equal(resolveToolModelRequirement(tool(name), { command: "cat file.txt" }).tier, "large");
  }
});

test("browser queries remain small, but generic interaction cannot assume read-only page behavior", () => {
  for (const name of ["open_page", "inspect_page", "capture_screenshot", "ground_with_google_search"]) {
    assert.equal(resolveToolModelRequirement(tool(name), {}).tier, "small");
  }
  const interaction = tool("interact_with_page");
  for (const action of ["scroll_up", "scroll_down", "wait", "go_back", "go_forward"]) {
    assert.equal(resolveToolModelRequirement(interaction, { action }).tier, "small");
  }
  for (const action of ["click", "type", "press", "select", "check", "uncheck", "upload", "submit", "future_action", undefined]) {
    assert.equal(resolveToolModelRequirement(interaction, { action }).tier, "large");
  }
  for (const name of ["save_browser_profile", "clear_browser_profile"]) {
    assert.equal(resolveToolModelRequirement(tool(name), {}).tier, "large");
  }
});

test("one-time current-session tasks differ from repeated or cross-session automation", () => {
  const descriptor = tool("create_scheduled_job");
  const context = { sessionId: "current" };
  for (const kind of ["delay", "at"]) {
    assert.equal(resolveToolModelRequirement(descriptor, { schedule: { kind }, sessionIds: ["current"] }, context).tier, "small");
  }
  for (const args of [
    { schedule: { kind: "cron" }, sessionIds: ["current"] },
    { schedule: { kind: "delay" }, sessionIds: ["other"] },
    { schedule: { kind: "at" }, sessionIds: ["current", "other"] },
    { schedule: { kind: "at" }, sessionIds: [] }, {}
  ]) {
    assert.equal(resolveToolModelRequirement(descriptor, args, context).tier, "large");
  }
  assert.equal(resolveToolModelRequirement(descriptor, { schedule: { kind: "delay" }, sessionIds: ["current"] }).tier, "large");
  assert.equal(resolveToolModelRequirement(tool("manage_scheduled_job"), { action: "disable" }).tier, "large");
});

test("bounded user and role-play content differs from policy, authority and external effects", () => {
  for (const name of ["patch_user_profile", "upsert_user_memory", "edit_character_section", "update_scenario_state",
    "asset_send_to_chat", "generate_image", "generate_speech", "sticker_collect"]) {
    assert.equal(resolveToolModelRequirement(tool(name), {}).tier, "small", name);
  }
  for (const name of ["upsert_global_rule", "remove_toolset_rule", "set_chat_permission", "set_user_special_role",
    "respond_request", "self_account_avatar_set", "delegate_message_to_chat"]) {
    assert.equal(resolveToolModelRequirement(tool(name), {}).tier, "large", name);
  }
});

test("skill maintenance uses the actual configuration phase rather than an untrusted draft argument", () => {
  for (const name of ["save_skill", "set_skill_paused"]) {
    const descriptor = tool(name);
    assert.equal(resolveToolModelRequirement(descriptor, { draft: true }).tier, "large");
    assert.equal(resolveToolModelRequirement(descriptor, {}, { operationMode: { kind: "normal" } }).tier, "large");
    assert.equal(resolveToolModelRequirement(descriptor, {}, { operationMode: { kind: "skill_config", skillId: "example" } }).tier, "small");
  }
});

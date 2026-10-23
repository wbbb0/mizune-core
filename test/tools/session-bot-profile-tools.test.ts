import test from "node:test";
import assert from "node:assert/strict";
import { sessionToolHandlers, sessionToolDescriptors } from "../../src/llm/tools/conversation/sessionTools.ts";
import { getBuiltinTools } from "../../src/llm/tools/index.ts";
import { TOOLSET_DEFINITIONS } from "../../src/llm/tools/toolsetCatalog.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("固定角色只能通过配置确认，不再提供绕过确认的聊天身份覆盖工具", () => {
  const obsolete = ["get_current_chat_identity", "patch_current_chat_identity", "clear_current_chat_identity"];
  const descriptorNames = sessionToolDescriptors.map(tool => tool.definition.function.name);
  const normalNames = getBuiltinTools("owner", null, createTestAppConfig(), {
    operationMode: { kind: "normal" }
  }).map(tool => tool.function.name);
  for (const name of obsolete) {
    assert.equal(sessionToolHandlers[name], undefined);
    assert.equal(descriptorNames.includes(name), false);
    assert.equal(normalNames.includes(name), false);
    assert.equal(TOOLSET_DEFINITIONS.some(toolset => toolset.toolNames.includes(name)), false);
  }
});

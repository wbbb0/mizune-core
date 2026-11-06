import type { ToolsetView } from "../llm/tools/toolsetCatalog.ts";
import type { SessionModeSetupToolsetOverride } from "#modes/types.ts";
import { characterRepository } from "./repository.ts";
import { stageSetupBindings } from "./setupEditing.ts";
import { characterToolNames } from "./tools.ts";

export const characterSetupToolsetOverrides: SessionModeSetupToolsetOverride[] = [{
  toolsetId: "memory_profile",
  title: "角色分块配置",
  description: "按分块填写当前阶段草稿",
  toolNames: characterToolNames,
  plannerSignals: ["角色配置"]
}, {
  toolsetId: "setup_draft",
  title: "设定草稿",
  description: "以独立消息发送当前阶段的完整角色草稿供用户审阅。",
  toolNames: ["send_setup_draft"],
  plannerSignals: ["发送设定草稿"]
}];

/** 当前阶段全部编辑工具直接展开；读取角色资料不改变工具集合。 */
export function expandCharacterSetupToolsets(toolsets: ToolsetView[], dataDir: string, sessionId?: string): ToolsetView[] {
  if (!sessionId) return toolsets;
  const draft = characterRepository(dataDir).draft(sessionId);
  if (!draft) return toolsets;
  const bindings = stageSetupBindings(draft.stage, draft.id);
  return toolsets.map(toolset => toolset.toolNames.includes("edit_character_section")
    ? { ...toolset, toolNames: toolset.toolNames.flatMap(name => name === "edit_character_section"
        ? bindings.map(binding => binding.definition.function.name) : [name]) }
    : toolset);
}

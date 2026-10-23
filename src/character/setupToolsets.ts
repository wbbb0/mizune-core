import type { ToolsetView } from "../llm/tools/toolsetCatalog.ts";
import { characterRepository } from "./repository.ts";
import { stageSetupBindings } from "./setupEditing.ts";

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

import type { ToolsetView } from "../llm/tools/toolsetCatalog.ts";
import { characterRepository } from "./repository.ts";
import { getCharacterSection, type CharacterSection } from "./schemaCatalog.ts";
import { stageSetupBindings } from "./setupEditing.ts";

export const CHARACTER_SETUP_GROUP_PREFIX = "character_setup_";

export function characterSetupToolsetId(section: CharacterSection): string {
  if (section.path[0] === "persona") return "memory_profile";
  const path = section.path.slice(0, 2).join("_");
  return `${CHARACTER_SETUP_GROUP_PREFIX}${section.scope === "session" ? "session_" : ""}${path}`;
}

/** 分组只负责按需加载 Schema；读取角色资料不改变工具集合。 */
export function expandCharacterSetupToolsets(toolsets: ToolsetView[], dataDir: string, sessionId?: string): ToolsetView[] {
  if (!sessionId) return toolsets;
  const draft = characterRepository(dataDir).draft(sessionId);
  if (!draft) return toolsets;
  const bindings = stageSetupBindings(draft.stage, draft.id);
  const groups = new Map<string, ToolsetView>();
  const result = toolsets.map(toolset => {
    if (!toolset.toolNames.includes("edit_character_section")) return toolset;
    const toolNames = toolset.toolNames.filter(name => name !== "edit_character_section");
    if (draft.stage === "persona") {
      toolNames.push(...bindings.map(binding => binding.definition.function.name));
    } else {
      for (const binding of bindings) {
        const section = getCharacterSection(binding.sectionId);
        const path = section.path.slice(0, 2).join(".");
        const id = characterSetupToolsetId(section);
        let group = groups.get(id);
        if (!group) {
          group = { id, title: `${path} 配置`, description: `填写 ${path} 分组。可直接编辑，无需先读取；读取不影响其他分块工具。`, toolNames: [] };
          groups.set(id, group);
        }
        group.toolNames.push(binding.definition.function.name);
      }
    }
    return { ...toolset, toolNames };
  });
  return [...result, ...groups.values()];
}

// 仅缓存草稿期间已加载的工具组，不存角色内容；重启后可重新申请加载。
const loadedGroups = new Map<string, { draftId: string; ids: Set<string> }>();
export function loadedCharacterSetupGroups(dataDir: string, sessionId: string, draftId: string): Set<string> {
  const key = JSON.stringify([dataDir, sessionId]);
  let entry = loadedGroups.get(key);
  if (entry?.draftId !== draftId) {
    if (loadedGroups.size >= 1000) loadedGroups.delete(loadedGroups.keys().next().value!);
    entry = { draftId, ids: new Set() };
    loadedGroups.set(key, entry);
  }
  return entry.ids;
}

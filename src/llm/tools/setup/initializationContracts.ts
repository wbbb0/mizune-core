import type { LlmToolDefinition } from "../../llmClient.ts";
import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";
import { createScenarioHostSetupToolsetOverrides } from "#modes/scenarioHost/setupToolsets.ts";
import { characterRepository } from "../../../character/repository.ts";
import { getCharacterSection } from "../../../character/schemaCatalog.ts";
import { selectedSetupSection, setupEditDefinition } from "../../../character/setupEditing.ts";

const scenarioSetupNames = new Set(createScenarioHostSetupToolsetOverrides().flatMap(group => group.toolNames));
export const isScenarioSetupToolName = (name: string) => scenarioSetupNames.has(name);
export function isScenarioSetupTool(name: string, operation?: SessionOperationMode): boolean {
  return !!operation && (operation.kind === "mode_setup" || operation.kind === "mode_config") && operation.modeId === "scenario_host" && scenarioSetupNames.has(name);
}
export function initializationToolDefinition(tool: LlmToolDefinition, dataDir?: string, sessionId?: string, operation?: SessionOperationMode): LlmToolDefinition[] {
  if (tool.function.name === "edit_character_section" && dataDir && sessionId) {
    const store = characterRepository(dataDir);
    const draft = store.draft(sessionId);
    if (draft) {
      const selected = selectedSetupSection(dataDir, sessionId);
      if (!selected) return [];
      // 初始化只能访问当前草稿层，模式在执行时再按真实会话检查。
      return [setupEditDefinition(getCharacterSection(selected.sectionId), draft.id)];
    }
  }
  if (!isScenarioSetupTool(tool.function.name, operation)) return [tool];
  const parameters = structuredClone(tool.function.parameters);
  if (tool.function.name === "update_scenario_state") {
    (parameters.properties as Record<string, any>).flags = { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "标记值只能是字符串、数字或布尔值，不能嵌套对象或数组。" };
  }
  return [{ ...tool, function: { ...tool.function, parameters,
    description: `${tool.function.description}\n配置阶段：按参数 Schema 直接提供对象或数组，不要把它们写成 JSON 字符串。仅填写本次需要修改的字段；数组按工具语义整体提供。action 必须使用列出的枚举，缺少条目 ID 时先读取场景状态。若返回错误，按字段提示修改后重试，不要重复原参数；最终确认由用户 .confirm 完成。`
  } }];
}

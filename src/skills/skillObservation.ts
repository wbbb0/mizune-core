import type { AppConfig } from "../config/config.ts";
import type { LlmMessage } from "../llm/provider/providerTypes.ts";
import type { SkillRecord } from "../types/skills.ts";
import { getSkillStore } from "./skillStore.ts";
export function skillObservation(kind: "load" | "resource" | "deferred" | "maintenance", skills: Array<Pick<SkillRecord, "id" | "revision">>, payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, skillContext: { kind, skills: skills.map(({ id, revision }) => ({ id, revision })) } });
}
/** 只撤销可识别的技能观察，保留工具消息及其 call/result 协议配对。 */
export function projectSkillObservations(config: AppConfig, messages: LlmMessage[]): LlmMessage[] {
  return messages.map(message => {
    if (message.role !== "tool" || typeof message.content !== "string")
      return message;
    let value: unknown;
    try {
      value = JSON.parse(message.content);
    }
    catch {
      return message;
    }
    if (!value || typeof value !== "object")
      return message;
    const envelope = (value as Record<string, unknown>).skillContext;
    if (!envelope || typeof envelope !== "object")
      return message;
    const { kind, skills } = envelope as {
      kind?: unknown;
      skills?: unknown;
    };
    if (!Array.isArray(skills) || !["load", "resource", "deferred", "maintenance"].includes(String(kind)))
      return message;
    const valid = config.skills.enabled && skills.every(ref => {
      if (!ref || typeof ref !== "object" || typeof ref.id !== "string" || !Number.isSafeInteger(ref.revision))
        return false;
      const store = getSkillStore(config);
      const current = store.get(ref.id);
      return current && store.summary(current).effectiveAvailable && store.isVersionValid(ref.id, ref.revision);
    });
    return valid ? message : { ...message, content: JSON.stringify({ revoked: true, message: "该技能观察已撤销：技能已禁用、暂停或删除。相关动作需重新评估。", skillContext: { kind, skills } }) };
  });
}

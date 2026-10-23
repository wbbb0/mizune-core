import type { Logger } from "pino";
import { z } from "zod";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { StatefulRpStateStore } from "./stateStore.ts";
import type { StatefulRpSessionState } from "./types.ts";
import { advanceCycle } from "../../character/cycle.ts";
import { getCharacterSection, readPath, setPath, validateJson } from "../../character/schemaCatalog.ts";

export interface StatefulRpPostTurnInput {
  sessionId: string; userText: string; assistantText: string; personaName: string;
  clockBeforeTurnIso?: string | null; outfitSignatureBeforeTurn?: string | null;
  abortSignal?: AbortSignal; isCurrent?: () => boolean;
}
const timeResult = z.object({ elapsedMinutes: z.number().int().min(0).max(10080) }).strict();
const editsResult = z.object({ edits: z.array(z.object({ id: z.string(), value: z.unknown() }).strict()).max(6) }).strict();
export function buildOutfitSignature(state: StatefulRpSessionState): string { return JSON.stringify(state.simulation.wardrobe.worn); }

export class StatefulRpPostTurnMaintainer {
  constructor(private readonly config: AppConfig, private readonly llmClient: LlmClient, private readonly stateStore: StatefulRpStateStore, private readonly logger: Logger) {}
  async runPostTurn(input: StatefulRpPostTurnInput): Promise<StatefulRpSessionState | null> {
    if (!this.config.statefulRp.postTurnMaintenanceEnabled || input.abortSignal?.aborted || this.stateStore.characters.draft(input.sessionId)) return null;
    const current = await this.stateStore.get(input.sessionId);
    if (!current?.initialized) return null;
    const profile = this.stateStore.characters.profile();
    const working = structuredClone(current);
    const clock = working.simulation.clock;
    if (!clock?.currentIso) return null;
    const stillCurrent = () => !input.abortSignal?.aborted && (input.isCurrent?.() ?? true) && this.stateStore.characters.profile().revision === profile.revision;
    const context = () => JSON.stringify({ character: profile, state: { social: working.social, simulation: working.simulation }, events: working.events, dialogue: { user: input.userText, assistant: input.assistantText } });
    try {
      let elapsed = 0;
      if (!input.clockBeforeTurnIso || input.clockBeforeTurnIso === clock.currentIso) {
        const result = timeResult.parse(await this.generate("只估计刚结束这一轮剧情实际经过的分钟数。没有时间流逝依据时为 0；禁止推进周期或改角色。只输出 JSON：{\"elapsedMinutes\":0}", context(), input));
        elapsed = result.elapsedMinutes;
        clock.currentIso = new Date(Date.parse(clock.currentIso) + elapsed * 60000).toISOString();
      } else elapsed = Math.max(0, (Date.parse(clock.currentIso) - Date.parse(input.clockBeforeTurnIso)) / 60000);
      clock.minutesSinceLastSensoryTick += elapsed;
      clock.minutesSinceLastMindTick += elapsed;
      advanceCycle(profile, working);
      if (!stillCurrent()) return null;
      const pass = async (title: string, ids: string[]) => {
        const sections = ids.map(getCharacterSection);
        const instructions = [
          `你是角色状态的${title}维护器，只更新动态信息，不能修改固定设定。`,
          "以已有状态和本轮事实为依据；没有变化时返回空 edits。不要把待办日程自动判为完成，不编造玩家行动。",
          "周期开始、结束和随机日期已经由代码结算；读取 events 和当前周期状态，不能自行触发、撤销或重算。",
          "只输出 JSON：{\"edits\":[{\"id\":\"允许的分块 ID\",\"value\":\"符合该块 Schema 的完整值\"}]}。最多六块。",
          JSON.stringify(sections.map(section => ({ id: section.id, schema: section.schema, current: readPath(working, section.path) })))
        ].join("\n");
        const result = editsResult.parse(await this.generate(instructions, context(), input));
        for (const edit of result.edits) {
          if (!ids.includes(edit.id)) throw new Error("维护器试图修改不允许的分块");
          const section = getCharacterSection(edit.id); validateJson(section.schema, edit.value, edit.id); setPath(working, section.path, edit.value);
        }
      };
      if (elapsed >= 60 && working.simulation.scene.separationStatus !== "together") {
        await pass("独处活动", ["session.simulation.scene", "session.simulation.schedule"]);
      }
      if (clock.minutesSinceLastSensoryTick >= this.config.statefulRp.embodimentTickMinutes || input.outfitSignatureBeforeTurn !== buildOutfitSignature(working)) {
        await pass("身体与感受", ["session.simulation.body.vitals", "session.simulation.body.sensations", "session.simulation.body.currentAppearance"]);
        clock.minutesSinceLastSensoryTick = 0;
      }
      if (clock.minutesSinceLastMindTick >= this.config.statefulRp.mindTickMinutes) {
        await pass("心理与社交", ["session.social.currentMood", "session.simulation.mind.emotions", "session.simulation.mind.surfaceVsInner"]);
        clock.minutesSinceLastMindTick = 0;
      }
      if (!stillCurrent()) return null;
      return this.stateStore.writeIfCurrent(input.sessionId, working, current.revision, stillCurrent);
    } catch (error) { this.logger.warn({ err: error, sessionId: input.sessionId }, "character_maintenance_failed"); return null; }
  }
  private async generate(system: string, content: string, input: StatefulRpPostTurnInput): Promise<unknown> {
    const refs = getModelRefsForRole(this.config, "main_small");
    const result = await this.llmClient.generate({ modelRefOverride: refs, timeoutMsOverride: Math.max(8000, this.config.llm.turnPlanner.timeoutMs), maxOutputTokensOverride: 1800, enableThinkingOverride: false, preferNativeNoThinkingChatEndpoint: true, skipDebugDump: true, ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}), messages: [{ role: "system", content: system }, { role: "user", content }] });
    return JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  }
}

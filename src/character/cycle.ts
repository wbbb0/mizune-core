import { randomInt, randomUUID } from "node:crypto";
import type { CharacterProfile, CharacterSession } from "./model.ts";

const dayMs = 86_400_000;
export function dateNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("日期必须是 YYYY-MM-DD");
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error("日期不存在");
  return time / dayMs;
}
const dateText = (day: number) => new Date(day * dayMs).toISOString().slice(0, 10);
export function gameDate(iso: string, timezone: string): string {
  if (!Number.isFinite(Date.parse(iso))) throw new Error("游戏时钟日期无效");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
export function deriveGameClock(state: CharacterSession): void {
  const clock = state.simulation.clock;
  if (!clock?.currentIso) return;
  gameDate(clock.currentIso, clock.timezone);
  const date = new Date(clock.currentIso);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: clock.timezone, hour: "numeric", hourCycle: "h23" }).format(date));
  clock.dayOfWeek = new Intl.DateTimeFormat("zh-CN", { timeZone: clock.timezone, weekday: "long" }).format(date);
  clock.timeOfDay = hour < 5 ? "深夜" : hour < 8 ? "清晨" : hour < 11 ? "上午" : hour < 14 ? "中午" : hour < 17 ? "下午" : hour < 19 ? "傍晚" : "夜晚";
}
export function cycleParameters(profile: CharacterProfile): { cycleDays: number; maxVariationDays: number; durationDays: number } | null {
  const mechanism = profile.embodiment.physiology.menstrualCycle;
  if (!mechanism || mechanism.mode !== "standard") return null;
  const p = mechanism.parameters;
  if (Object.keys(p).some(key => !["cycleDays", "maxVariationDays", "durationDays"].includes(key))) throw new Error("周期参数仅支持 cycleDays、maxVariationDays、durationDays");
  for (const key of ["cycleDays", "maxVariationDays", "durationDays"]) {
    if (p[key] != null && (!Number.isInteger(p[key]) || p[key] < (key === "maxVariationDays" ? 0 : 1) || p[key] > 36600)) throw new Error(`周期参数 ${key} 无效`);
  }
  if ([p.cycleDays, p.maxVariationDays, p.durationDays].some(value => value == null)) return null;
  if (p.cycleDays - p.maxVariationDays <= p.durationDays) throw new Error("最短周期必须大于持续天数");
  return p;
}
/** 只在状态事务内调用；随机结果与事件和状态一次提交。 */
export function advanceCycle(profile: CharacterProfile, state: CharacterSession, draw = randomInt): void {
  deriveGameClock(state);
  const mechanism = profile.embodiment.physiology.menstrualCycle;
  const body = state.simulation.body;
  if (mechanism?.mode === "disabled") {
    body.activePhysiology.menstrualCycle = null;
    state.cycleConfig = null;
    return;
  }
  const parameters = cycleParameters(profile);
  const clock = state.simulation.clock;
  const cycle = body.activePhysiology.menstrualCycle;
  if (!parameters || !clock?.currentIso || !cycle?.lastStartDate) return;
  const now = dateNumber(gameDate(clock.currentIso, clock.timezone));
  let start = dateNumber(cycle.lastStartDate);
  if (start > now) throw new Error("上次开始日期不能晚于游戏日期");
  const signature = JSON.stringify(parameters);
  const next = (from: number) => from + parameters.cycleDays + (parameters.maxVariationDays ? draw(-parameters.maxVariationDays, parameters.maxVariationDays + 1) : 0);
  // 配置变化只重排未来开始日期，已开始的这一轮保留原结束日期。
  if (state.cycleConfig !== signature || !cycle.nextStartDate) {
    const planned = next(start);
    cycle.nextStartDate = dateText(state.cycleConfig != null && state.cycleConfig !== signature
      ? Math.max(now + 1, planned, cycle.currentEndDate ? dateNumber(cycle.currentEndDate) : planned)
      : planned);
    cycle.currentEndDate ??= dateText(start + parameters.durationDays);
    state.cycleConfig = signature;
  }
  const emit = (date: string, kind: string, summary: string) => state.events.push({ id: randomUUID(), date, kind, summary });
  let end = dateNumber(cycle.currentEndDate);
  if (cycle.active && now >= end) emit(dateText(end), "cycle_ended", "周期事件已结束。");
  let iterations = 0;
  while (now >= dateNumber(cycle.nextStartDate)) {
    if (++iterations > 10000) throw new Error("时间跳跃过大，请分段推进");
    start = dateNumber(cycle.nextStartDate);
    end = start + parameters.durationDays;
    emit(dateText(start), "cycle_started", "周期事件已开始，由代码判定。");
    if (now >= end) emit(dateText(end), "cycle_ended", "周期事件已结束。");
    cycle.lastStartDate = dateText(start);
    cycle.currentEndDate = dateText(end);
    cycle.nextStartDate = dateText(next(start));
  }
  cycle.active = now >= start && now < end;
  state.events = state.events.slice(-40);
}

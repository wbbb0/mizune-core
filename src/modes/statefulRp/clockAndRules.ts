import {
  statefulRpSessionStateSchema,
  type StatefulRpActivityKind,
  type StatefulRpClockState,
  type StatefulRpCycleState,
  type StatefulRpSessionState
} from "./types.ts";

const WEEKDAY_NAMES_ZH = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function formatIsoToDisplayClock(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso.trim());
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  const local = new Date(parsed.getTime() + 8 * 3600_000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const min = String(local.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function parseDisplayClockToIso(input: string, _timezone = "Asia/Shanghai"): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const displayMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (displayMatch) {
    const [, yyyy, mm, dd, hh, min, sec = "00"] = displayMatch;
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}+08:00`;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return advanceIsoByMinutes(new Date(parsed).toISOString(), 0);
}

export function advanceIsoByMinutes(iso: string, minutes: number): string {
  const baseMs = Date.parse(iso);
  const safeBaseMs = Number.isNaN(baseMs) ? Date.parse("2026-05-16T14:00:00+08:00") : baseMs;
  const targetMs = safeBaseMs + Math.round(minutes) * 60_000;
  const shanghaiDate = new Date(targetMs + 8 * 3600_000);
  const yyyy = shanghaiDate.getUTCFullYear();
  const mm = String(shanghaiDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shanghaiDate.getUTCDate()).padStart(2, "0");
  const hh = String(shanghaiDate.getUTCHours()).padStart(2, "0");
  const min = String(shanghaiDate.getUTCMinutes()).padStart(2, "0");
  const sec = String(shanghaiDate.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}+08:00`;
}

export function deriveClockFields(iso: string): Pick<StatefulRpClockState, "currentIso" | "dayOfWeek" | "timeOfDay"> {
  const normalizedIso = advanceIsoByMinutes(iso, 0);
  const ms = Date.parse(normalizedIso);
  const shanghaiDate = new Date(ms + 8 * 3600_000);
  const dayOfWeek = WEEKDAY_NAMES_ZH[shanghaiDate.getUTCDay()] ?? "六";
  const hour = shanghaiDate.getUTCHours();

  let timeOfDay: StatefulRpClockState["timeOfDay"] = "下午";
  if (hour >= 5 && hour < 8) timeOfDay = "清晨";
  else if (hour >= 8 && hour < 11) timeOfDay = "上午";
  else if (hour >= 11 && hour < 14) timeOfDay = "中午";
  else if (hour >= 14 && hour < 17) timeOfDay = "下午";
  else if (hour >= 17 && hour < 19) timeOfDay = "傍晚";
  else if (hour >= 19 && hour < 23) timeOfDay = "夜晚";
  else timeOfDay = "深夜";

  return {
    currentIso: normalizedIso,
    dayOfWeek,
    timeOfDay
  };
}

function getDatePartFromIso(iso: string): string {
  return deriveClockFields(iso).currentIso.slice(0, 10);
}

function deriveCyclePhase(dayOfCycle: number, cycleLength: number): StatefulRpCycleState["phase"] {
  if (dayOfCycle <= 5) return "menstruation";
  const ovulationDay = Math.max(10, cycleLength - 14);
  if (dayOfCycle >= ovulationDay - 1 && dayOfCycle <= ovulationDay + 2) return "ovulation";
  if (dayOfCycle < ovulationDay - 1) return "follicular";
  return "luteal";
}

export function applyDeterministicTimeTick(
  state: StatefulRpSessionState,
  input: {
    elapsedMinutes: number;
    activityKind: StatefulRpActivityKind;
    isSeparated: boolean;
  }
): {
  nextState: StatefulRpSessionState;
  dueScheduleIds: string[];
  newlyOverduePromiseIds: string[];
} {
  const next = structuredClone(state);
  const elapsed = clamp(input.elapsedMinutes, 0, 10_080);
  const prevIso = next.clock.currentIso;
  const prevDatePart = getDatePartFromIso(prevIso);
  const nextIso = advanceIsoByMinutes(prevIso, elapsed);
  const nextDatePart = getDatePartFromIso(nextIso);
  const derivedClock = deriveClockFields(nextIso);

  next.clock.currentIso = derivedClock.currentIso;
  next.clock.dayOfWeek = derivedClock.dayOfWeek;
  next.clock.timeOfDay = derivedClock.timeOfDay;
  next.clock.lastActivityKind = input.activityKind;
  next.clock.minutesSinceLastEmbodimentTick += elapsed;
  next.clock.minutesSinceLastMindTick += elapsed;
  next.world.isSeparated = input.isSeparated;

  const hours = elapsed / 60;
  const vitals = next.embodiment.vitals;

  // 1. 生理指标确定性时间演化
  if (input.activityKind === "resting") {
    vitals.stamina = clamp(vitals.stamina + hours * 18, 0, 100);
    vitals.energy = clamp(vitals.energy + hours * 15, 0, 100);
    vitals.hygiene = clamp(vitals.hygiene - hours * 1.5, 0, 100);
  } else if (input.activityKind === "grooming") {
    vitals.hygiene = clamp(vitals.hygiene + 45, 0, 100);
    vitals.bladder = clamp(vitals.bladder - 70, 0, 100);
  } else if (input.activityKind === "walking") {
    vitals.stamina = clamp(vitals.stamina - hours * 8, 0, 100);
    vitals.energy = clamp(vitals.energy - hours * 5, 0, 100);
    vitals.hygiene = clamp(vitals.hygiene - hours * 5, 0, 100);
  } else if (input.activityKind === "active" || input.activityKind === "intimate") {
    vitals.stamina = clamp(vitals.stamina - hours * 18, 0, 100);
    vitals.energy = clamp(vitals.energy - hours * 10, 0, 100);
    vitals.hygiene = clamp(vitals.hygiene - hours * 12, 0, 100);
  } else {
    vitals.stamina = clamp(vitals.stamina - hours * 3, 0, 100);
    vitals.energy = clamp(vitals.energy - hours * 4, 0, 100);
    vitals.hygiene = clamp(vitals.hygiene - hours * 2.5, 0, 100);
  }

  vitals.hunger = clamp(vitals.hunger + hours * 7, 0, 100);
  vitals.thirst = clamp(vitals.thirst + hours * 10, 0, 100);
  if (input.activityKind !== "grooming") {
    vitals.bladder = clamp(vitals.bladder + hours * 8, 0, 100);
  }
  if (vitals.intoxication > 0) {
    vitals.intoxication = clamp(vitals.intoxication - hours * 12, 0, 100);
  }

  // 2. 衣物与私密道具穿戴时长及汗湿/气味确定性累积
  const sweatRatePerHour =
    input.activityKind === "active" || input.activityKind === "intimate"
      ? 18
      : input.activityKind === "walking"
        ? 9
        : input.activityKind === "resting"
          ? 2
          : 4;

  for (const item of next.embodiment.outfit.items) {
    item.wornMinutes += elapsed;
    const breathabilityFactor = Math.max(0.25, (100 - item.breathability) / 60);
    const addedWetness = hours * sweatRatePerHour * breathabilityFactor;
    item.wetness = clamp(item.wetness + addedWetness, 0, 100);
    if (item.wornMinutes >= 120 || item.wetness >= 20 || item.secretionStain >= 15) {
      const addedOdor = hours * (3 + item.wetness * 0.08 + item.secretionStain * 0.12) * breathabilityFactor;
      item.odorIntensity = clamp(item.odorIntensity + addedOdor, 0, 100);
    }
    if (item.wetness >= 30 || item.wornMinutes >= 300) {
      item.comfort = clamp(item.comfort - hours * 4 * breathabilityFactor, 10, 100);
    }
  }

  for (const gear of next.embodiment.outfit.intimateGear) {
    gear.wornMinutes += elapsed;
  }

  // 3. 跨日生理周期推进
  if (nextDatePart > prevDatePart) {
    const rawDiff = Math.round(
      (Date.parse(`${nextDatePart}T00:00:00Z`) - Date.parse(`${prevDatePart}T00:00:00Z`)) / 86_400_000
    );
    const dayDiff = Number.isFinite(rawDiff) ? Math.max(1, rawDiff) : 1;
    const cycleLen = next.embodiment.cycle.cycleLength;
    next.embodiment.cycle.dayOfCycle = ((next.embodiment.cycle.dayOfCycle - 1 + dayDiff) % cycleLen) + 1;
    next.embodiment.cycle.phase = deriveCyclePhase(next.embodiment.cycle.dayOfCycle, cycleLen);
  }

  // 4. 日程与约定到期检测
  const nextMs = Date.parse(next.clock.currentIso);
  const dueScheduleIds: string[] = [];
  for (const entry of next.world.schedule) {
    if (entry.status === "pending" && Date.parse(entry.startIso) <= nextMs) {
      dueScheduleIds.push(entry.id);
    }
  }

  const newlyOverduePromiseIds: string[] = [];
  for (const promise of next.relationship.promises) {
    if (promise.status === "pending" && promise.dueIso && Date.parse(promise.dueIso) < nextMs) {
      promise.status = "overdue";
      newlyOverduePromiseIds.push(promise.id);
    }
  }

  return {
    nextState: clampAndCompactState(next),
    dueScheduleIds,
    newlyOverduePromiseIds
  };
}

export function clampAndCompactState(state: StatefulRpSessionState): StatefulRpSessionState {
  const next = statefulRpSessionStateSchema.parse(state);
  if (next.journal.length > 24) {
    next.journal = next.journal.slice(-24);
  }
  if (next.maintenanceLog.length > 20) {
    next.maintenanceLog = next.maintenanceLog.slice(-20);
  }
  if (next.mind.intrusiveThoughts.length > 6) {
    next.mind.intrusiveThoughts = next.mind.intrusiveThoughts.slice(0, 6);
  }
  return next;
}

import type { StatefulRpSessionState } from "./types.ts";
export function buildStatefulRpStateLines(state: StatefulRpSessionState): string[] {
  return [`会话初始化：${state.initialized ? "已确认" : "未确认"}`, `动态状态：${JSON.stringify({ social: state.social, simulation: state.simulation })}`, `代码事件：${JSON.stringify(state.events)}`];
}
export function buildStatefulRpPlannerSignalLine(state: StatefulRpSessionState | null, _text?: string): string {
  return state?.initialized ? `沉浸状态 RP：${state.simulation.scene.location ?? "地点未指定"}` : "角色模式尚待确认初始化";
}

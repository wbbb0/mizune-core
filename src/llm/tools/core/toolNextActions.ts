export interface ToolNextAction {
  tool: string;
  reason: string;
  args: Record<string, string | number | boolean | string[]>;
}

export function nextAction(
  tool: string,
  reason: string,
  args: Record<string, string | number | boolean | string[]>
): ToolNextAction {
  return { tool, reason, args };
}

export function withNextActions<T extends Record<string, unknown>>(
  payload: T,
  actions: ToolNextAction[]
): T & { next_actions?: ToolNextAction[] } {
  const nextActions = actions.slice(0, 4);
  return nextActions.length > 0
    ? { ...payload, next_actions: nextActions }
    : payload;
}

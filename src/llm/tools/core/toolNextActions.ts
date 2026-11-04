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

/** Filters only the controlled result envelope, never arbitrary nested user JSON. */
export function filterToolNextActions(
  payload: Record<string, unknown>,
  visibleToolNames: ReadonlySet<string>
): Record<string, unknown> {
  if (!Array.isArray(payload.next_actions)) return payload;
  const actions = payload.next_actions.filter((action: unknown) =>
    typeof action === "object" && action !== null && "tool" in action
    && typeof action.tool === "string" && visibleToolNames.has(action.tool));
  const { next_actions: _ignored, ...rest } = payload;
  return actions.length ? { ...rest, next_actions: actions } : rest;
}

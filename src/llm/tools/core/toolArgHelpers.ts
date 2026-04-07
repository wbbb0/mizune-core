export function getStringArg(args: unknown, key: string): string {
  return typeof args === "object" && args && key in args
    ? String((args as Record<string, unknown>)[key] ?? "").trim()
    : "";
}

export function getNumberArg(args: unknown, key: string): number | undefined {
  if (typeof args !== "object" || !args || !(key in args)) {
    return undefined;
  }
  const value = Number((args as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : undefined;
}

export function getBooleanArg(args: unknown, key: string): boolean | undefined {
  if (typeof args !== "object" || !args || !(key in args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getStringArrayArg(args: unknown, key: string): string[] | undefined {
  if (typeof args !== "object" || !args || !(key in args)) {
    return undefined;
  }

  const value = (args as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);

  return items.length > 0 ? items : [];
}

export function setPropertyByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter((part) => part.length > 0);
  const lastPart = parts.pop();
  if (!lastPart) {
    return;
  }

  let current: Record<string, unknown> = obj;
  for (const part of parts) {
    const nextValue = current[part];
    if (typeof nextValue !== "object" || nextValue === null) {
      const nextObject: Record<string, unknown> = {};
      current[part] = nextObject;
      current = nextObject;
      continue;
    }

    current = nextValue as Record<string, unknown>;
  }

  current[lastPart] = value;
}

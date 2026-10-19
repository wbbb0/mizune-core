/** OpenRouter streams reasoning text separately from opaque replay blocks. */
export class OpenRouterReasoning {
  private readonly blocks = new Map<number, Record<string, unknown>>();

  append(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    let received = false;
    for (const raw of value) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const block = raw as Record<string, unknown>;
      const index = block.index;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) continue;
      const previous = this.blocks.get(index) ?? {};
      const next = { ...previous, ...block };
      for (const key of ["text", "summary", "data"] as const) {
        if (typeof block[key] === "string" && typeof previous[key] === "string") next[key] = previous[key] + block[key];
      }
      this.blocks.set(index, next);
      received = true;
    }
    return received;
  }

  get details(): Record<string, unknown>[] {
    return [...this.blocks].sort(([left], [right]) => left - right).map(([, block]) => block);
  }
}

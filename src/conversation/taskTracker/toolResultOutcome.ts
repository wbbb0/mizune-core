export type ToolResultOutcome = "succeeded" | "failed" | "in_progress";

const FAILED_STATUSES = new Set(["failed", "error", "rejected", "cancelled", "canceled"]);
const IN_PROGRESS_STATUSES = new Set(["running", "active", "pending", "queued", "paused", "waiting"]);

export function parseToolResultObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function classifyToolResultOutcome(parsed: Record<string, unknown> | null): ToolResultOutcome {
  if (!parsed) {
    return "succeeded";
  }
  const nestedSession = readNestedObject(parsed.session);
  const statuses = [parsed.status, parsed.state, parsed.phase, nestedSession?.status, nestedSession?.state]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  const exitCode = parsed.exitCode ?? parsed.exit_code;
  if (
    parsed.error
    || parsed.ok === false
    || statuses.some((status) => FAILED_STATUSES.has(status))
    || typeof exitCode === "number" && exitCode !== 0
  ) {
    return "failed";
  }
  if (
    parsed.running === true
    || statuses.some((status) => IN_PROGRESS_STATUSES.has(status))
  ) {
    return "in_progress";
  }
  return "succeeded";
}

function readNestedObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface ScheduledJobTarget {
  sessionId: string;
}

export type ScheduledJobSchedule =
  | {
      kind: "delay";
      delayMs: number;
    }
  | {
      kind: "at";
      runAtMs: number;
      tz: string;
    }
  | {
      kind: "cron";
      expr: string;
      tz: string;
    };

export interface ScheduledJobState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastRunStatus: "ok" | "error" | "running" | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveErrors: number;
}

export interface ScheduledJob {
  id: string;
  name: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: ScheduledJobSchedule;
  instruction: string;
  targets: ScheduledJobTarget[];
  state: ScheduledJobState;
}

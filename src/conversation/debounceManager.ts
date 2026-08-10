import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SessionDebounceAccess } from "#conversation/session/sessionCapabilities.ts";

export class DebounceManager {
  constructor(
    private readonly logger: Logger,
    private readonly sessionManager: SessionDebounceAccess,
    private readonly config: AppConfig
  ) {}

  schedule(
    sessionId: string,
    onFire: () => void,
    options?: {
      multiplierOverride?: number;
      reason?: "default" | "gate_wait";
    }
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    const cfg = this.config.conversation.debounce;
    const reason = options?.reason ?? "default";
    const preference = reason === "default"
      ? session.pacingPreferences.inputDebounce
      : { mode: "adaptive" as const };
    const defaultBaseMs = cfg.defaultBaseSeconds * 1000;
    const minBaseMs = cfg.minBaseSeconds * 1000;
    const maxBaseMs = cfg.maxBaseSeconds * 1000;
    const randomRatioMin = cfg.randomRatioMin;
    const randomRatioMax = cfg.randomRatioMax;
    const alpha = cfg.smoothingFactor;
    const extraMultiplier = options?.multiplierOverride ?? 1;

    const latestGapMs = session.latestGapMs ?? defaultBaseMs;
    let smoothedBaseMs: number | null = null;
    let randomRatio = 1;
    let actualDelayMs: number;
    if (preference.mode === "immediate") {
      actualDelayMs = 0;
    } else if (preference.mode === "fixed") {
      actualDelayMs = preference.delayMs;
    } else {
      const previousSmoothed = session.smoothedGapMs ?? defaultBaseMs;
      smoothedBaseMs = Math.min(
        maxBaseMs,
        Math.max(minBaseMs, previousSmoothed + alpha * (latestGapMs - previousSmoothed))
      );
      randomRatio = cfg.randomRatioMin < cfg.randomRatioMax
        ? Math.random() * (randomRatioMax - randomRatioMin) + randomRatioMin
        : 1;
      actualDelayMs = Math.round(smoothedBaseMs * cfg.finalMultiplier * extraMultiplier * randomRatio);
      session.smoothedGapMs = smoothedBaseMs;
    }
    this.sessionManager.clearDebounceTimer(sessionId);
    const timer = setTimeout(() => {
      this.sessionManager.clearDebounceTimer(sessionId);
      onFire();
    }, actualDelayMs);
    this.sessionManager.setDebounceTimer(sessionId, timer);
    this.logger.debug(
      {
        sessionId,
        latestGapMs,
        smoothedBaseMs: smoothedBaseMs == null ? null : Math.round(smoothedBaseMs),
        reason,
        pacingMode: preference.mode,
        extraMultiplier,
        randomRatio,
        actualDelayMs
      },
      "debounce_scheduled"
    );
  }
}

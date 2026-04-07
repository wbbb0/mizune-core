import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SessionManager } from "#conversation/session/sessionManager.ts";

export class DebounceManager {
  constructor(
    private readonly logger: Logger,
    private readonly sessionManager: SessionManager,
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
    const defaultBaseMs = cfg.defaultBaseSeconds * 1000;
    const minBaseMs = cfg.minBaseSeconds * 1000;
    const maxBaseMs = cfg.maxBaseSeconds * 1000;
    const randomRatioMin = cfg.randomRatioMin;
    const randomRatioMax = cfg.randomRatioMax;
    const alpha = cfg.smoothingFactor;
    const extraMultiplier = options?.multiplierOverride ?? 1;

    const previousSmoothed = session.smoothedGapMs ?? defaultBaseMs;
    const latestGapMs = session.latestGapMs ?? defaultBaseMs;
    const smoothedBaseMs = previousSmoothed + alpha * (latestGapMs - previousSmoothed);
    const clampedBaseMs = Math.min(maxBaseMs, Math.max(minBaseMs, smoothedBaseMs));
    const randomRatio = cfg.randomRatioMin < cfg.randomRatioMax ? Math.random() * (randomRatioMax - randomRatioMin) + randomRatioMin : 1;
    const actualDelayMs = Math.round(clampedBaseMs * cfg.finalMultiplier * extraMultiplier * randomRatio);

    session.smoothedGapMs = clampedBaseMs;
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
        smoothedBaseMs: Math.round(clampedBaseMs),
        reason: options?.reason ?? "default",
        extraMultiplier,
        randomRatio,
        actualDelayMs
      },
      "debounce_scheduled"
    );
  }
}

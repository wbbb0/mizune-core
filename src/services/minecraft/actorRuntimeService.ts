import type { AppConfig } from "#config/config.ts";
import type { Logger } from "pino";
import type { MinecraftActorResourceManager } from "./actorResourceManager.ts";

interface ActorPollFailure {
  attempts: number;
  nextAttemptAtMs: number;
}

export interface MinecraftRuntimeSupervisor {
  start(): Promise<void>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export class MinecraftActorRuntimeService {
  private readonly failures = new Map<string, ActorPollFailure>();
  private timer: NodeJS.Timeout | null = null;
  private pollOperation: Promise<void> | null = null;
  private stopOperation: Promise<void> | null = null;
  private started = false;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly manager: MinecraftActorResourceManager,
    private readonly supervisor: MinecraftRuntimeSupervisor,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    if (this.started || !this.config.minecraft.enabled) return;
    if (this.stopping) throw new Error("Minecraft Actor runtime service 正在关闭");
    this.started = true;
    const recoveredDecisions = await this.manager.recoverMailbox();
    if (recoveredDecisions > 0) {
      this.logger.warn({ recoveredDecisions }, "minecraft_actor_decisions_recovered");
    }
    await this.supervisor.start();
    await this.pollNow();
    if (this.stopping) return;
    this.timer = setInterval(() => {
      void this.pollNow();
    }, this.config.minecraft.eventPollIntervalMs);
    this.timer.unref?.();
    this.logger.info({ intervalMs: this.config.minecraft.eventPollIntervalMs }, "minecraft_actor_runtime_started");
  }

  async pollNow(): Promise<void> {
    if (this.stopping || !this.config.minecraft.enabled) return;
    const existing = this.pollOperation;
    if (existing) return existing;
    const operation = this.pollActiveResources().finally(() => {
      if (this.pollOperation === operation) this.pollOperation = null;
    });
    this.pollOperation = operation;
    return operation;
  }

  stop(): Promise<void> {
    this.stopOperation ??= this.performStop();
    return this.stopOperation;
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pollOperation?.catch(() => undefined);
    const failures: unknown[] = [];
    try {
      await this.manager.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.supervisor.stop();
    } catch (error) {
      failures.push(error);
    }
    this.started = false;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Minecraft Actor runtime 未能安全收敛");
    }
    this.logger.info("minecraft_actor_runtime_stopped");
  }

  private async pollActiveResources(): Promise<void> {
    await this.supervisor.reconcile();
    const records = (await this.manager.list()).filter(record => (
      record.status === "active"
      && record.minecraftActor?.binding.desiredState === "open"
      && record.minecraftActor.binding.provisionStatus === "ready"
    ));
    const activeIds = new Set(records.map(record => record.resourceId));
    for (const resourceId of this.failures.keys()) {
      if (!activeIds.has(resourceId)) this.failures.delete(resourceId);
    }
    await Promise.all(records.map(async record => {
      const failure = this.failures.get(record.resourceId);
      if (failure && failure.nextAttemptAtMs > this.now()) return;
      try {
        await this.manager.ingestEvents(record.resourceId);
        void this.manager.processMailbox(record.resourceId).catch(error => {
          this.logger.warn({ err: error, resourceId: record.resourceId }, "minecraft_actor_mailbox_processing_failed");
        });
        if (failure) {
          this.logger.info({ resourceId: record.resourceId }, "minecraft_actor_runtime_recovered");
        }
        this.failures.delete(record.resourceId);
      } catch (error) {
        const attempts = (failure?.attempts ?? 0) + 1;
        const retryAfterMs = Math.min(30_000, this.config.minecraft.eventPollIntervalMs * 2 ** Math.min(attempts, 5));
        this.failures.set(record.resourceId, {
          attempts,
          nextAttemptAtMs: this.now() + retryAfterMs
        });
        this.logger.warn({
          err: error,
          resourceId: record.resourceId,
          attempts,
          retryAfterMs
        }, "minecraft_actor_runtime_poll_failed");
      }
    }));
  }
}

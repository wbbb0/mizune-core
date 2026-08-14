import type { MinecraftActorJournalEvent } from "./actorControlStore.ts";

export type MinecraftActorJournalListener = (event: MinecraftActorJournalEvent) => void;

/**
 * 进程内 journal 提交通知总线。
 *
 * SQLite 中的事件记录是事实来源；此对象只负责在事务提交后把同一事件推给
 * SSE 等实时投影，监听器失败不能反向影响已经提交的业务事务。
 */
export class MinecraftActorJournal {
  private readonly listeners = new Set<MinecraftActorJournalListener>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: MinecraftActorJournalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(events: readonly MinecraftActorJournalEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Journal commit is authoritative; a projection cannot roll it back.
        }
      }
    }
  }
}

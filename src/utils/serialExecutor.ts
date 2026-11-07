import PQueue from "p-queue";

/** FIFO serialization with rejection isolation. Tasks must not await a nested run on this executor. */
export class SerialExecutor {
  private readonly queue = new PQueue({ concurrency: 1 });

  run<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.add(task);
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }
}

import type { DeliveryCoordinator, DeliveryReference } from "#services/messaging/deliveryCoordinator.ts";

type Stream = ReturnType<DeliveryCoordinator["openTextStream"]>;
interface Segment {
  text: string;
  pending: string;
  controller: AbortController;
  interrupted: boolean;
  start: Promise<void>;
  stream?: Stream;
  closing?: Promise<void>;
  removeListeners: () => void;
}

/** Orders logical text bubbles around media without holding the media queue while generating. */
export class NativeStreamDelivery {
  private current: Segment | undefined;
  private readonly segments = new Set<Segment>();
  private barrier: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(private readonly deps: {
    initialBarrier: Promise<void>;
    signals: () => AbortSignal[];
    scheduleStart: (text: string, signal: AbortSignal, send: () => Promise<void>) => Promise<unknown>;
    captureOpen: () => () => Stream;
    accepted: (text: string, reference: DeliveryReference) => void;
    onCloseError: (error: unknown) => void;
  }) {
    this.barrier = deps.initialBarrier;
    void this.barrier.catch(() => undefined);
  }

  get text(): string { return this.current?.text ?? ""; }

  append(delta: string): void {
    const signals = this.deps.signals();
    if (!delta || signals.some(signal => signal.aborted)) return;
    if (this.failure) throw this.failure;
    if ((this.current?.pending.length ?? 0) + delta.length > 1_048_576) throw new Error("原生流待发内容超过上限。");
    let segment = this.current;
    if (!segment) {
      const controller = new AbortController();
      segment = { text: delta, pending: delta, controller, interrupted: false, start: Promise.resolve(), removeListeners() {} };
      const created = segment;
      this.current = created;
      this.segments.add(created);
      const cancel = () => { void this.close(created, true).catch(this.deps.onCloseError); };
      for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
      created.removeListeners = () => { for (const signal of signals) signal.removeEventListener("abort", cancel); };
      const previous = this.barrier;
      // Capture the stream address before a later steering message changes the reply permit.
      const open = this.deps.captureOpen();
      created.start = this.deps.scheduleStart(delta, AbortSignal.any([...signals, controller.signal]), async () => {
        if (!await waitUntilReady(previous, controller.signal)) return;
        if (created.interrupted || signals.some(signal => signal.aborted)) return;
        created.stream = open();
        created.stream.append(created.pending);
        created.pending = "";
      }).then(() => undefined).catch(error => { this.failure = error; throw error; });
      void created.start.catch(() => undefined);
      return;
    }
    segment.text += delta;
    if (segment.stream) segment.stream.append(delta);
    else segment.pending += delta;
  }

  beginExternalDelivery(): { ready: Promise<void>; settle: () => void } {
    const segment = this.current;
    this.current = undefined;
    const ready = this.failure ? Promise.reject(this.failure) : segment ? this.close(segment, false) : this.barrier;
    let settle!: () => void;
    const completed = new Promise<void>(resolve => { settle = resolve; });
    this.barrier = ready.then(() => completed);
    // The tool observes ready; subsequent output also observes a failed seal.
    void this.barrier.catch(() => undefined);
    return { ready, settle };
  }

  async finish(): Promise<void> {
    const segment = this.current;
    this.current = undefined;
    if (segment) this.barrier = this.close(segment, false);
    await this.barrier;
    if (this.failure) throw this.failure;
  }

  async interrupt(): Promise<void> {
    this.current = undefined;
    // Never wait for a media gate here: cancellation must release text waiting behind it.
    await Promise.all([...this.segments].map(segment => this.close(segment, true)));
    if (this.failure) throw this.failure;
  }

  private close(segment: Segment, interrupted: boolean): Promise<void> {
    if (this.current === segment) this.current = undefined;
    if (interrupted) {
      segment.interrupted = true;
      segment.pending = "";
      segment.controller.abort();
      // Upgrade an in-flight normal finish without flushing its unsent suffix.
      if (segment.stream) void segment.stream.interrupt().catch(() => undefined);
    }
    if (segment.closing) return segment.closing;
    segment.closing = segment.start.then(async () => {
      const stream = segment.stream;
      if (!stream) return;
      let receipt;
      try {
        receipt = await (segment.interrupted ? stream.interrupt() : stream.finish());
      } catch (error) {
        const receipt = stream.receipt;
        if (receipt?.acceptedText) this.deps.accepted(receipt.acceptedText, { platform: "qq_official", connectionId: receipt.connectionId, messageId: receipt.messageId });
        this.failure = error;
        throw error;
      }
      // Local persistence failure must not repeat the accepted-message bookkeeping.
      if (receipt?.acceptedText) this.deps.accepted(receipt.acceptedText, { platform: "qq_official", connectionId: receipt.connectionId, messageId: receipt.messageId });
    }).finally(() => {
      segment.removeListeners();
      this.segments.delete(segment);
    });
    void segment.closing.catch(() => undefined);
    return segment.closing;
  }
}

function waitUntilReady(promise: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); resolve(false); };
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(() => { signal.removeEventListener("abort", cancel); resolve(!signal.aborted); }, error => {
      signal.removeEventListener("abort", cancel);
      reject(error);
    });
  });
}

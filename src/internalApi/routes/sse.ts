import type { FastifyReply, FastifyRequest } from "fastify";

export class SseConnectionRegistry {
  private readonly closeHandlers = new Set<() => void>();

  register(close: () => void): () => void {
    this.closeHandlers.add(close);
    return () => this.closeHandlers.delete(close);
  }

  closeAll(): void {
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const close of handlers) close();
  }

  get size(): number {
    return this.closeHandlers.size;
  }
}

export function replyWithSseStream<TEvent extends { type: string }>(
  request: FastifyRequest,
  reply: FastifyReply,
  stream: {
    initialEvents: TEvent[];
    subscribe: (listener: (event: TEvent) => void) => () => void;
  },
  options?: {
    heartbeatMs?: number;
    eventId?: (event: TEvent) => string | number | null | undefined;
    isTerminalEvent?: (event: TEvent) => boolean;
    maxBufferedEvents?: number;
    maxBufferedBytes?: number;
    connectionRegistry?: SseConnectionRegistry;
  }
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  let closed = false;
  let unsubscribe = () => {};
  let unregisterConnection = () => {};
  let backpressured = false;
  let bufferedBytes = 0;
  const pendingFrames: Array<{ frame: string; terminal: boolean }> = [];
  const heartbeatTimer = setInterval(() => {
    if (!reply.raw.destroyed && !backpressured) {
      reply.raw.write(": ping\n\n");
    }
  }, options?.heartbeatMs ?? 15_000);
  heartbeatTimer.unref?.();

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeatTimer);
    unsubscribe();
    unregisterConnection();
    request.raw.off("close", handleClose);
    reply.raw.off("drain", handleDrain);
  };

  const handleClose = () => {
    cleanup();
    if (!reply.raw.destroyed) {
      reply.raw.end();
    }
  };

  const writeEvent = (event: TEvent) => {
    const eventId = options?.eventId?.(event);
    let frame = "";
    if (eventId !== undefined && eventId !== null) {
      frame += `id: ${eventId}\n`;
    }
    frame += `event: ${event.type}\n`;
    frame += `data: ${JSON.stringify(event)}\n\n`;
    const terminal = options?.isTerminalEvent?.(event) === true;
    if (backpressured) {
      if (
        pendingFrames.length >= (options?.maxBufferedEvents ?? 1_024)
        || bufferedBytes + Buffer.byteLength(frame, "utf8") > (options?.maxBufferedBytes ?? 1_048_576)
      ) {
        cleanup();
        reply.raw.end();
        return;
      }
      pendingFrames.push({ frame, terminal });
      bufferedBytes += Buffer.byteLength(frame, "utf8");
      return;
    }
    const accepted = reply.raw.write(frame);
    if (!accepted) backpressured = true;
    if (terminal && accepted) {
      cleanup();
      reply.raw.end();
    } else if (terminal) {
      pendingFrames.push({ frame: "", terminal: true });
    }
  };

  const handleDrain = () => {
    if (closed) return;
    backpressured = false;
    while (pendingFrames.length > 0) {
      const next = pendingFrames.shift()!;
      bufferedBytes -= Buffer.byteLength(next.frame, "utf8");
      if (next.frame && !reply.raw.write(next.frame)) {
        backpressured = true;
        if (next.terminal) pendingFrames.unshift({ frame: "", terminal: true });
        return;
      }
      if (next.terminal) {
        cleanup();
        reply.raw.end();
        return;
      }
    }
  };

  let initialEventsDelivered = false;
  const bufferedEvents: TEvent[] = [];
  const streamUnsubscribe = stream.subscribe(event => {
    if (initialEventsDelivered) {
      writeEvent(event);
      return;
    }
    if (bufferedEvents.length >= (options?.maxBufferedEvents ?? 1_024)) {
      cleanup();
      reply.raw.end();
      return;
    }
    bufferedEvents.push(event);
  });
  if (closed) {
    streamUnsubscribe();
    return;
  }
  unsubscribe = streamUnsubscribe;
  request.raw.on("close", handleClose);
  reply.raw.on("drain", handleDrain);
  unregisterConnection = options?.connectionRegistry?.register(() => {
    cleanup();
    if (!reply.raw.destroyed) {
      reply.raw.end();
      reply.raw.destroy();
    }
  }) ?? (() => {});

  for (const event of stream.initialEvents) {
    writeEvent(event);
    if (closed) {
      return;
    }
  }
  initialEventsDelivered = true;
  for (const event of bufferedEvents) {
    writeEvent(event);
    if (closed) return;
  }
}

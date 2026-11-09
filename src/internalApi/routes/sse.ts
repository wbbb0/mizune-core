import type { FastifyReply, FastifyRequest } from "fastify";

type QueuedFrame = {
  frame: string;
  terminal: boolean;
};

const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_BYTES = 1024 * 1024;

export function replyWithSseStream<TEvent extends { type: string }>(
  request: FastifyRequest,
  reply: FastifyReply,
  stream: {
    initialEvents: TEvent[];
    subscribe: (listener: (event: TEvent) => void) => () => void;
  },
  options?: {
    heartbeatMs?: number;
    isTerminalEvent?: (event: TEvent) => boolean;
    maxPendingEvents?: number;
    maxPendingBytes?: number;
  }
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const raw = reply.raw;
  const pending: QueuedFrame[] = [];
  const maxPendingEvents = options?.maxPendingEvents ?? MAX_PENDING_EVENTS;
  const maxPendingBytes = options?.maxPendingBytes ?? MAX_PENDING_BYTES;
  let pendingBytes = 0;
  let closed = false;
  let blocked = false;
  let draining = false;
  let unsubscribe: (() => void) | undefined;
  let subscribing = true;
  const eventsDuringSubscribe: TEvent[] = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    request.raw.off("close", handleClose);
    raw.off("drain", handleDrain);
    const release = unsubscribe;
    unsubscribe = undefined;
    release?.();
    pending.length = 0;
    pendingBytes = 0;
  };

  const end = () => {
    cleanup();
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  };

  const writeFrame = (queued: QueuedFrame): boolean => {
    const accepted = raw.write(queued.frame);
    if (queued.terminal) {
      end();
      return false;
    }
    return accepted;
  };

  const drainPending = () => {
    if (closed || blocked || draining) return;
    draining = true;
    try {
      while (!closed && pending.length > 0) {
        const queued = pending.shift()!;
        pendingBytes -= Buffer.byteLength(queued.frame);
        if (!writeFrame(queued)) {
          blocked = true;
          break;
        }
      }
    } finally {
      draining = false;
    }
  };

  const enqueueFrame = (queued: QueuedFrame) => {
    if (closed || raw.destroyed || raw.writableEnded) return;
    if (!blocked && pending.length === 0) {
      if (!writeFrame(queued)) blocked = true;
      return;
    }
    const bytes = Buffer.byteLength(queued.frame);
    if (pending.length >= maxPendingEvents || pendingBytes + bytes > maxPendingBytes) {
      // Slow clients reconnect from their cursor instead of accumulating memory.
      end();
      return;
    }
    pending.push(queued);
    pendingBytes += bytes;
  };

  const writeEvent = (event: TEvent) => {
    if (closed) return;
    enqueueFrame({
      frame: `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      terminal: options?.isTerminalEvent?.(event) ?? false
    });
  };

  const handleDrain = () => {
    blocked = false;
    drainPending();
  };

  const handleClose = () => {
    cleanup();
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  };

  const heartbeatTimer = setInterval(() => {
    if (closed || raw.destroyed || raw.writableEnded || blocked || pending.length > 0) return;
    if (!raw.write(": ping\n\n")) blocked = true;
  }, options?.heartbeatMs ?? 15_000);
  heartbeatTimer.unref?.();

  raw.on("drain", handleDrain);
  request.raw.on("close", handleClose);

  try {
    unsubscribe = stream.subscribe((event) => {
      if (subscribing) eventsDuringSubscribe.push(event);
      else writeEvent(event);
    });
  } catch (error) {
    end();
    throw error;
  } finally {
    subscribing = false;
  }

  // Initial snapshot precedes mutations observed during subscription setup.
  for (const event of stream.initialEvents) {
    writeEvent(event);
    if (closed) return;
  }
  for (const event of eventsDuringSubscribe) {
    writeEvent(event);
    if (closed) return;
  }
}

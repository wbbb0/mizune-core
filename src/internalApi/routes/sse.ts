import type { FastifyReply, FastifyRequest } from "fastify";

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
  }
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  let closed = false;
  const heartbeatTimer = setInterval(() => {
    if (!reply.raw.destroyed) {
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
    request.raw.off("close", handleClose);
  };

  const handleClose = () => {
    cleanup();
    if (!reply.raw.destroyed) {
      reply.raw.end();
    }
  };

  const writeEvent = (event: TEvent) => {
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    if (options?.isTerminalEvent?.(event)) {
      cleanup();
      reply.raw.end();
    }
  };

  const unsubscribe = stream.subscribe(writeEvent);
  request.raw.on("close", handleClose);

  for (const event of stream.initialEvents) {
    writeEvent(event);
    if (closed) {
      return;
    }
  }
}

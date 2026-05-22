import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { InternalApiServices } from "../types.ts";

const MAX_SOCKET_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_QUEUED_FRAME_COUNT = 1024;

export interface ShellWebSocketAuthOptions {
  enabled: boolean;
  verifyCookie: (cookie: string | undefined) => boolean;
}

type ShellClientMessage =
  | { kind: "input"; data: string }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "signal"; signal: string }
  | { kind: "close" };

export function registerShellWebSocketUpgrade(
  server: { on(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown },
  services: InternalApiServices["shellRoutes"],
  auth: ShellWebSocketAuthOptions
): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true });
  const upgradedSockets = new Set<WebSocket>();

  server.on("upgrade", (request, socket, head) => {
    const sessionId = parseAttachSessionId(request.url);
    if (!sessionId) {
      if (isShellAttachRequest(request.url)) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
      return;
    }

    if (auth.enabled && !auth.verifyCookie(request.headers.cookie)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      upgradedSockets.add(ws);
      ws.on("close", () => upgradedSockets.delete(ws));
      void attachShellSocket(ws, services, sessionId);
    });
  });

  return () => new Promise((resolve) => {
    for (const ws of upgradedSockets) {
      ws.close(1001, "server closing");
    }
    wss.close(() => resolve());
  });
}

async function attachShellSocket(
  ws: WebSocket,
  services: InternalApiServices["shellRoutes"],
  sessionId: string
): Promise<void> {
  let disposed = false;
  let socketClosed = false;
  let ready = false;
  const queuedMessages: string[] = [];
  const queuedOutbound: string[] = [];
  let queuedMessageBytes = 0;
  let queuedOutboundBytes = 0;
  const closeForBackpressure = () => {
    ws.close(1013, "terminal websocket backpressure");
  };
  const sendFrameNow = (frame: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount + Buffer.byteLength(frame, "utf8") > MAX_SOCKET_BUFFERED_BYTES) {
        closeForBackpressure();
        return;
      }
      ws.send(frame, (error) => {
        if (error) {
          ws.close(1011, "terminal output failed");
        }
      });
    }
  };
  const sendNow = (payload: unknown) => {
    sendFrameNow(JSON.stringify(payload));
  };
  const send = (payload: unknown) => {
    const frame = JSON.stringify(payload);
    if (!ready) {
      const byteLength = Buffer.byteLength(frame, "utf8");
      if (
        queuedOutbound.length >= MAX_QUEUED_FRAME_COUNT
        || queuedOutboundBytes + byteLength > MAX_QUEUED_FRAME_BYTES
      ) {
        closeForBackpressure();
        return;
      }
      queuedOutbound.push(frame);
      queuedOutboundBytes += byteLength;
      return;
    }
    sendFrameNow(frame);
  };

  ws.on("message", (message) => {
    const raw = message.toString("utf8");
    if (!ready) {
      const byteLength = Buffer.byteLength(raw, "utf8");
      if (
        queuedMessages.length >= MAX_QUEUED_FRAME_COUNT
        || queuedMessageBytes + byteLength > MAX_QUEUED_FRAME_BYTES
      ) {
        closeForBackpressure();
        return;
      }
      queuedMessages.push(raw);
      queuedMessageBytes += byteLength;
      return;
    }
    void handleShellSocketMessage(ws, services, sessionId, raw);
  });
  ws.on("close", () => {
    socketClosed = true;
  });
  ws.on("error", () => {
    socketClosed = true;
  });

  try {
    const subscription = await services.shellRuntime.subscribe(sessionId, send);
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      subscription.dispose();
    };
    if (socketClosed || ws.readyState !== WebSocket.OPEN) {
      dispose();
      return;
    }

    ready = true;
    sendNow({
      kind: "hello",
      session: subscription.session,
      replay: subscription.replay
    });
    for (const frame of queuedOutbound.splice(0)) {
      sendFrameNow(frame);
    }
    queuedOutboundBytes = 0;

    for (const raw of queuedMessages.splice(0)) {
      void handleShellSocketMessage(ws, services, sessionId, raw);
    }
    queuedMessageBytes = 0;
    ws.on("close", dispose);
    ws.on("error", dispose);
  } catch (error: unknown) {
    sendNow({ kind: "error", error: error instanceof Error ? error.message : String(error) });
    ws.close(1011, "shell attach failed");
  }
}

async function handleShellSocketMessage(
  ws: WebSocket,
  services: InternalApiServices["shellRoutes"],
  sessionId: string,
  raw: string
): Promise<void> {
  const sendError = (error: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ kind: "error", error }));
    }
  };

  const parsed = parseShellClientMessage(raw);
  if (!parsed) {
    sendError("invalid shell websocket message");
    return;
  }

  try {
    if (parsed.kind === "input") {
      await services.shellRuntime.writeRaw(sessionId, parsed.data);
      return;
    }
    if (parsed.kind === "resize") {
      await services.shellRuntime.resize(sessionId, parsed.cols, parsed.rows);
      return;
    }
    if (parsed.kind === "signal") {
      await services.shellRuntime.signal(sessionId, parsed.signal);
      return;
    }
    services.shellRuntime.closeSession(sessionId);
  } catch (error: unknown) {
    sendError(error instanceof Error ? error.message : String(error));
  }
}

function isShellAttachRequest(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url, "http://internal");
    return /^\/api\/shell\/sessions\/.+\/attach$/.test(parsed.pathname);
  } catch {
    return url.startsWith("/api/shell/sessions/") && url.endsWith("/attach");
  }
}

function parseAttachSessionId(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url, "http://internal");
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^\/api\/shell\/sessions\/([^/]+)\/attach$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

function parseShellClientMessage(raw: string): ShellClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kind === "input" && typeof candidate.data === "string") {
    return { kind: "input", data: candidate.data };
  }
  if (
    candidate.kind === "resize"
    && Number.isFinite(candidate.cols)
    && Number.isFinite(candidate.rows)
  ) {
    return {
      kind: "resize",
      cols: Math.max(2, Math.min(1000, Math.round(Number(candidate.cols)))),
      rows: Math.max(1, Math.min(1000, Math.round(Number(candidate.rows))))
    };
  }
  if (candidate.kind === "signal" && typeof candidate.signal === "string" && candidate.signal.trim()) {
    return { kind: "signal", signal: candidate.signal.trim() };
  }
  if (candidate.kind === "close") {
    return { kind: "close" };
  }
  return null;
}

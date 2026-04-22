import { randomUUID } from "node:crypto";

export type WebTurnStreamEvent =
  | {
      type: "ready";
      turnId: string;
      sessionId: string;
      timestampMs: number;
    }
  | {
      type: "draft_delta";
      turnId: string;
      sessionId: string;
      delta: string;
      timestampMs: number;
    }
  | {
      type: "segment_committed";
      turnId: string;
      sessionId: string;
      timestampMs: number;
    }
  | {
      type: "complete";
      turnId: string;
      sessionId: string;
      timestampMs: number;
    }
  | {
      type: "turn_error";
      turnId: string;
      sessionId: string;
      message: string;
      timestampMs: number;
    };

type WebTurnSubscriber = (event: WebTurnStreamEvent) => void;

type WebTurnState = {
  turnId: string;
  sessionId: string;
  createdAt: number;
  events: WebTurnStreamEvent[];
  subscribers: Set<WebTurnSubscriber>;
  status: "running" | "complete" | "turn_error";
  cleanupTimer: NodeJS.Timeout | null;
};

const WEB_TURN_TTL_MS = 5 * 60_000;

export interface WebTurnBroker {
  create(sessionId: string): WebTurnState;
  getStream(sessionId: string, turnId: string): {
    turnId: string;
    initialEvents: WebTurnStreamEvent[];
    subscribe: (listener: WebTurnSubscriber) => () => void;
  };
  publish(turnState: WebTurnState, event: WebTurnStreamEvent): void;
  complete(turnState: WebTurnState): void;
  fail(turnState: WebTurnState): void;
}

export function createWebTurnBroker(): WebTurnBroker {
  const webTurnStates = new Map<string, WebTurnState>();

  function scheduleCleanup(turnState: WebTurnState): void {
    if (turnState.cleanupTimer) {
      clearTimeout(turnState.cleanupTimer);
    }
    turnState.cleanupTimer = setTimeout(() => {
      webTurnStates.delete(turnState.turnId);
    }, WEB_TURN_TTL_MS);
    turnState.cleanupTimer.unref?.();
  }

  return {
    create(sessionId) {
      const turnState: WebTurnState = {
        turnId: randomUUID(),
        sessionId,
        createdAt: Date.now(),
        events: [],
        subscribers: new Set(),
        status: "running",
        cleanupTimer: null
      };
      webTurnStates.set(turnState.turnId, turnState);
      return turnState;
    },

    getStream(sessionId, turnId) {
      const turnState = webTurnStates.get(turnId);
      if (!turnState || turnState.sessionId !== sessionId) {
        throw new Error("Web turn not found");
      }

      return {
        turnId: turnState.turnId,
        initialEvents: [...turnState.events],
        subscribe(listener) {
          turnState.subscribers.add(listener);
          return () => {
            turnState.subscribers.delete(listener);
          };
        }
      };
    },

    publish(turnState, event) {
      turnState.events.push(event);
      for (const subscriber of turnState.subscribers) {
        subscriber(event);
      }
    },

    complete(turnState) {
      turnState.status = "complete";
      scheduleCleanup(turnState);
    },

    fail(turnState) {
      turnState.status = "turn_error";
      scheduleCleanup(turnState);
    }
  };
}

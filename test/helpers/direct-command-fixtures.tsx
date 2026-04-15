import { createDirectCommandHandler } from "../../src/app/messaging/directCommands.ts";
import { createTestAppConfig } from "./config-fixtures.tsx";

type SentImmediateText = {
  sessionId: string;
  userId: string;
  groupId?: string;
  text: string;
  recordInHistory?: boolean;
  recordForRetract?: boolean;
  autoRetractAfterMs?: number;
};

interface DirectCommandFixtureOptions {
  session?: Record<string, unknown>;
  cancelGeneration?: () => boolean;
  clearSession?: () => void;
  forceCompactSession?: (sessionId: string, retainMessageCount?: number) => Promise<boolean>;
  appendHistory?: (sessionId: string, role: "user" | "assistant", content: string, timestampMs?: number) => void;
  appendUserHistory?: (sessionId: string, message: Record<string, unknown>, timestampMs?: number) => void;
  appendSyntheticPendingMessage?: (sessionId: string, message: Record<string, unknown>) => void;
  appendDebugMarker?: (sessionId: string, marker: Record<string, unknown>) => void;
  flushSession?: (sessionId: string, options?: { skipReplyGate?: boolean }) => void;
  setDebugEnabled?: (sessionId: string, enabled: boolean) => { enabled: boolean; oncePending: boolean };
  armDebugOnce?: (sessionId: string) => { enabled: boolean; oncePending: boolean };
  getDebugControlState?: (sessionId: string) => { enabled: boolean; oncePending: boolean };
  persistSession?: (sessionId: string, reason: string) => void;
  getModeId?: (sessionId: string) => string;
  scenarioHostStateStore?: {
    write: (sessionId: string, state: unknown) => Promise<unknown>;
  };
}

export function createDirectCommandFixture(options: DirectCommandFixtureOptions = {}) {
  const calls: SentImmediateText[] = [];
  const session = {
    id: "private:owner",
    type: "private",
    lastLlmUsage: null,
    isGenerating: false,
    pendingMessages: [],
    recentMessages: [],
    historySummary: null,
    sentMessages: [],
    ...options.session
  };

  const handler = createDirectCommandHandler({
    config: createTestAppConfig({
      shell: {
        enabled: true
      }
    }),
    sessionManager: {
      ensureSession() {
        return session;
      },
      cancelGeneration() {
        return options.cancelGeneration?.() ?? false;
      },
      clearSession() {
        options.clearSession?.();
      },
      popRetractableSentMessages() {
        return [];
      },
      appendSyntheticPendingMessage(sessionId: string, message: Record<string, unknown>) {
        options.appendSyntheticPendingMessage?.(sessionId, message);
        return session;
      },
      appendHistory(sessionId: string, role: "user" | "assistant", content: string, timestampMs?: number) {
        options.appendHistory?.(sessionId, role, content, timestampMs);
      },
      appendUserHistory(sessionId: string, message: Record<string, unknown>, timestampMs?: number) {
        options.appendUserHistory?.(sessionId, message, timestampMs);
      },
      appendDebugMarker(sessionId: string, marker: Record<string, unknown>) {
        options.appendDebugMarker?.(sessionId, marker);
      },
      setDebugEnabled(sessionId: string, enabled: boolean) {
        return options.setDebugEnabled?.(sessionId, enabled) ?? { enabled, oncePending: false };
      },
      armDebugOnce(sessionId: string) {
        return options.armDebugOnce?.(sessionId) ?? { enabled: false, oncePending: true };
      },
      getDebugControlState(sessionId: string) {
        return options.getDebugControlState?.(sessionId) ?? { enabled: false, oncePending: false };
      },
      getModeId(sessionId: string) {
        return options.getModeId?.(sessionId) ?? "rp_assistant";
      }
    } as unknown as Parameters<typeof createDirectCommandHandler>[0]["sessionManager"],
    oneBotClient: {
      async deleteMessage() {
        return { status: "ok", retcode: 0, data: null };
      }
    } as unknown as Parameters<typeof createDirectCommandHandler>[0]["oneBotClient"],
    logger: {
      info() {},
      warn() {}
    } as unknown as Parameters<typeof createDirectCommandHandler>[0]["logger"],
    persistSession(sessionId: string, reason: string) {
      options.persistSession?.(sessionId, reason);
    },
    flushSession(sessionId: string, flushOptions?: { skipReplyGate?: boolean }) {
      options.flushSession?.(sessionId, flushOptions);
    },
    ...(options.forceCompactSession ? { forceCompactSession: options.forceCompactSession } : {}),
    ...(options.scenarioHostStateStore ? { scenarioHostStateStore: options.scenarioHostStateStore as any } : {}),
    async sendImmediateText(params: SentImmediateText) {
      calls.push(params);
    }
  });

  return {
    calls,
    handler
  };
}

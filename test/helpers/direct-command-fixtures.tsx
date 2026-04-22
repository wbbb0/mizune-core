import { createDirectCommandHandler } from "../../src/app/messaging/directCommands.ts";
import { createTestAppConfig } from "./config-fixtures.tsx";

type SentImmediateText = {
  sessionId: string;
  userId: string;
  externalUserId?: string;
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
  getLlmVisibleHistory?: (sessionId: string) => Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  setTitle?: (sessionId: string, title: string, titleSource: "default" | "auto" | "manual") => unknown;
  appendInternalTranscript?: (sessionId: string, item: Record<string, unknown>) => void;
  markSetupConfirmed?: (sessionId: string) => void;
  getOperationMode?: (sessionId: string) => unknown;
  setOperationMode?: (sessionId: string, operationMode: unknown) => unknown;
  personaStore?: {
    get: () => Promise<unknown>;
    isComplete: (persona: unknown) => boolean;
    createEmpty?: () => unknown;
    write?: (persona: unknown) => Promise<void>;
  };
  rpProfileStore?: {
    get: () => Promise<unknown>;
    isComplete?: (profile: unknown) => boolean;
    createEmpty?: () => unknown;
    write?: (profile: unknown) => Promise<void>;
  };
  scenarioProfileStore?: {
    get: () => Promise<unknown>;
    isComplete?: (profile: unknown) => boolean;
    createEmpty?: () => unknown;
    write?: (profile: unknown) => Promise<void>;
  };
  globalProfileReadinessStore?: {
    get: () => Promise<unknown>;
    setPersonaReadiness: (status: "uninitialized" | "ready") => Promise<unknown>;
    setRpReadiness?: (status: "uninitialized" | "ready") => Promise<unknown>;
    setScenarioReadiness?: (status: "uninitialized" | "ready") => Promise<unknown>;
  };
  setupStore?: {
    get?: () => Promise<unknown>;
    advanceAfterPersonaUpdate?: (persona: unknown) => Promise<unknown>;
  };
  scenarioHostStateStore?: {
    write: (sessionId: string, state: unknown) => Promise<unknown>;
    update?: (
      sessionId: string,
      updater: (current: any) => any | Promise<any>,
      defaults: { playerUserId: string; playerDisplayName: string }
    ) => Promise<unknown>;
  };
  sessionCaptioner?: {
    isAvailable: () => boolean;
    generateTitle: (input: Record<string, unknown>) => Promise<string | null>;
  };
}

export function createDirectCommandFixture(options: DirectCommandFixtureOptions = {}) {
  const calls: SentImmediateText[] = [];
  const session = {
    id: "qqbot:p:owner",
    type: "private",
    modeId: "rp_assistant",
    operationMode: { kind: "normal" },
    participantRef: { kind: "user", id: "owner" },
    title: null,
    titleSource: "default",
    source: "onebot",
    setupConfirmed: false,
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
      getOperationMode(sessionId: string) {
        return options.getOperationMode?.(sessionId) ?? session.operationMode;
      },
      setOperationMode(sessionId: string, operationMode: unknown) {
        session.operationMode = operationMode as any;
        return options.setOperationMode?.(sessionId, operationMode) ?? operationMode;
      },
      getModeId(sessionId: string) {
        return options.getModeId?.(sessionId) ?? "rp_assistant";
      },
      getLlmVisibleHistory(sessionId: string) {
        return options.getLlmVisibleHistory?.(sessionId) ?? [];
      },
      setTitle(sessionId: string, title: string, titleSource: "default" | "auto" | "manual") {
        return options.setTitle?.(sessionId, title, titleSource) ?? session;
      },
      appendInternalTranscript(sessionId: string, item: Record<string, unknown>) {
        options.appendInternalTranscript?.(sessionId, item);
      },
      markSetupConfirmed(sessionId: string) {
        options.markSetupConfirmed?.(sessionId);
      },
      clearPendingTranscriptGroup() {
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
    personaStore: options.personaStore as any ?? {
      async get() {
        return {};
      },
      createEmpty() {
        return {};
      },
      async write() {
      },
      isComplete() {
        return false;
      }
    },
    rpProfileStore: options.rpProfileStore as any ?? {
      async get() {
        return {};
      },
      createEmpty() {
        return {};
      },
      async write() {
      },
      isComplete() {
        return false;
      }
    },
    scenarioProfileStore: options.scenarioProfileStore as any ?? {
      async get() {
        return {};
      },
      createEmpty() {
        return {};
      },
      async write() {
      },
      isComplete() {
        return false;
      }
    },
    globalProfileReadinessStore: options.globalProfileReadinessStore as any ?? {
      async get() {
        return {
          persona: "uninitialized",
          rp: "uninitialized",
          scenario: "uninitialized",
          updatedAt: 1
        };
      },
      async setPersonaReadiness() {
        return null;
      },
      async setRpReadiness() {
        return null;
      },
      async setScenarioReadiness() {
        return null;
      }
    },
    setupStore: options.setupStore as any ?? {
      async get() {
        return { state: "ready" };
      },
      async advanceAfterPersonaUpdate() {
        return null;
      }
    },
    ...(options.forceCompactSession ? { forceCompactSession: options.forceCompactSession } : {}),
    ...(options.scenarioHostStateStore ? { scenarioHostStateStore: options.scenarioHostStateStore as any } : {}),
    ...(options.sessionCaptioner ? { sessionCaptioner: options.sessionCaptioner as any } : {}),
    async sendImmediateText(params: SentImmediateText) {
      calls.push(params);
    }
  });

  return {
    calls,
    handler
  };
}

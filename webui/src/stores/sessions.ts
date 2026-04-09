import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { SessionListItem, SessionPhase, TranscriptItem, SessionStreamEvent, TurnStreamEvent } from "@/api/types";
import { sessionsApi } from "@/api/sessions";

const SESSION_DEBUG_ENABLED = import.meta.env.DEV;

function debugSession(event: string, detail?: Record<string, unknown>): void {
  if (!SESSION_DEBUG_ENABLED) {
    return;
  }
  console.debug("[sessions]", event, detail ?? {});
}

export interface TranscriptEntry {
  eventId: string;
  index: number;
  item: TranscriptItem;
}

export interface ActiveSession {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  participantUserId: string;
  participantLabel: string | null;
  mutationEpoch: number;
  transcriptCount: number;
  pendingMessageCount: number;
  lastActiveAt: number;
  streamStatus: "connecting" | "connected" | "error";
  phase: SessionPhase;
  transcript: TranscriptEntry[];
  /** Live assistant text chunks while web-turn is in progress */
  streamingText: string | null;
  composerUserId: string | null;
}

export const useSessionsStore = defineStore("sessions", () => {
  const list = ref<SessionListItem[]>([]);
  const selectedId = ref<string | null>(null);
  const active = shallowRef<ActiveSession | null>(null);

  let _es: EventSource | null = null;
  let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let _reconnectDelay = 1000;

  async function refresh(): Promise<void> {
    const res = await sessionsApi.list();
    list.value = res.sessions;
    debugSession("refresh", {
      sessions: res.sessions.map((session) => session.id)
    });
  }

  function _openStream(sessionId: string, epoch?: number, transcriptCount?: number): void {
    debugSession("open_stream:start", { sessionId, epoch, transcriptCount });
    _closeStream();

    const currentEpoch = epoch ?? 0;
    const requestedTranscriptCount = transcriptCount ?? 0;

    if (active.value?.id !== sessionId) {
      active.value = {
        id: sessionId,
        type: "private",
        source: "web",
        participantUserId: "",
        participantLabel: null,
        mutationEpoch: currentEpoch,
        transcriptCount: requestedTranscriptCount,
        pendingMessageCount: 0,
        lastActiveAt: 0,
        streamStatus: "connecting",
        phase: {
          kind: "idle",
          label: "连接中"
        },
        transcript: [],
        streamingText: null,
        composerUserId: null
      };
    } else {
      active.value = { ...active.value, streamStatus: "connecting" };
    }

    const es = sessionsApi.openStream(sessionId, {
      mutationEpoch: epoch,
      transcriptCount: requestedTranscriptCount
    });
    _es = es;
    _reconnectDelay = 1000;
    debugSession("open_stream:created", {
      sessionId,
      mutationEpoch: epoch ?? null,
      transcriptCount: requestedTranscriptCount
    });

    es.onopen = () => {
      if (_es !== es) {
        return;
      }
      debugSession("open_stream:onopen", { sessionId, readyState: es.readyState });
      if (active.value?.id === sessionId) {
        active.value = { ...active.value, streamStatus: "connected" };
      }
    };

    es.addEventListener("message", () => { /* ignore generic messages */ });

    for (const eventType of ["ready", "reset", "status", "transcript_item", "session_error"] as const) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        if (_es !== es) return;
        try {
          const event = JSON.parse(e.data) as SessionStreamEvent;
          debugSession("open_stream:event", {
            sessionId,
            eventType: event.type,
            readyState: es.readyState
          });
          _handleEvent(event);
        } catch { /* malformed event */ }
      });
    }

    es.onerror = () => {
      if (_es !== es) return;
      debugSession("open_stream:onerror", {
        sessionId,
        readyState: es.readyState,
        currentStatus: active.value?.streamStatus ?? null
      });
      if (active.value?.id === sessionId) {
        active.value = { ...active.value, streamStatus: "connecting" };
      }
      _scheduleReconnect(sessionId);
    };
  }

  function _handleEvent(event: SessionStreamEvent): void {
    const cur = active.value;
    if (!cur) return;

    if (event.type === "session_error") {
      debugSession("handle_event:session_error", {
        activeSessionId: cur.id,
        message: event.message
      });
      _closeStream();
      active.value = { ...cur, streamStatus: "error" };
      return;
    }

    if (cur.id !== event.sessionId) return;

    if (event.type === "ready") {
      active.value = {
        ...cur,
        streamStatus: "connected",
        mutationEpoch: event.mutationEpoch,
        transcriptCount: event.transcriptCount,
        pendingMessageCount: event.pendingMessageCount,
        lastActiveAt: event.lastActiveAt,
        phase: event.phase
      };
      return;
    }

    if (event.type === "reset") {
      active.value = {
        ...cur,
        mutationEpoch: event.mutationEpoch,
        transcriptCount: 0,
        pendingMessageCount: event.pendingMessageCount,
        lastActiveAt: event.lastActiveAt,
        phase: event.phase,
        streamStatus: "connecting",
        transcript: [],
        streamingText: null,
        composerUserId: cur.composerUserId
      };
      _openStream(cur.id, event.mutationEpoch, 0);
      return;
    }

    if (event.type === "status") {
      active.value = {
        ...cur,
        mutationEpoch: event.mutationEpoch,
        pendingMessageCount: event.pendingMessageCount,
        lastActiveAt: event.lastActiveAt,
        phase: event.phase
      };
      return;
    }

    if (event.type === "transcript_item") {
      const already = cur.transcript.some((t) => t.eventId === event.eventId);
      if (!already) {
        const transcript = [...cur.transcript, { eventId: event.eventId, index: event.index, item: event.item }];
        const isAssistantMessage = event.item.kind === "assistant_message";
        active.value = {
          ...cur,
          transcript,
          transcriptCount: event.totalCount,
          ...(isAssistantMessage ? { streamingText: null } : {})
        };
      }
    }
  }

  function _scheduleReconnect(sessionId: string): void {
    if (_reconnectTimer) return;
    debugSession("reconnect:scheduled", { sessionId, delayMs: _reconnectDelay });
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      if (selectedId.value === sessionId) {
        const cur = active.value;
        _openStream(sessionId, cur?.mutationEpoch, cur?.transcriptCount);
        _reconnectDelay = Math.min(_reconnectDelay * 2, 15_000);
      }
    }, _reconnectDelay);
  }

  function _closeStream(): void {
    if (_es) {
      _es.close();
      _es = null;
    }
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
  }

  function selectSession(sessionId: string): void {
    if (selectedId.value === sessionId) return;
    selectedId.value = sessionId;
    const selected = list.value.find((item) => item.id === sessionId);
    if (selected) {
      active.value = {
        id: selected.id,
        type: selected.type,
        source: selected.source,
        participantUserId: selected.participantUserId,
        participantLabel: selected.participantLabel,
        mutationEpoch: 0,
        transcriptCount: 0,
        pendingMessageCount: selected.pendingMessageCount,
        lastActiveAt: selected.lastActiveAt,
        streamStatus: "connecting",
        phase: {
          kind: "idle",
          label: "连接中"
        },
        transcript: [],
        streamingText: null,
        composerUserId: selected.participantUserId
      };
    }
    _openStream(sessionId);
  }

  function deselectSession(): void {
    selectedId.value = null;
    active.value = null;
    _closeStream();
  }

  async function sendMessage(opts: {
    userId: string;
    senderName?: string;
    text: string;
    imageIds?: string[];
  }): Promise<void> {
    const sessionId = selectedId.value;
    if (!sessionId) return;
    const cur = active.value;
    if (!cur) return;

    active.value = {
      ...cur,
      composerUserId: opts.userId
    };
    const { turnId } = await sessionsApi.sendTurn(sessionId, {
      userId: opts.userId,
      senderName: opts.senderName,
      text: opts.text,
      imageIds: opts.imageIds
    });
    _subscribeTurnStream(sessionId, turnId);
  }

  async function createSession(input: {
    participantUserId: string;
    participantLabel?: string;
  }): Promise<string> {
    const result = await sessionsApi.create(input);
    await refresh();
    selectSession(result.session.id);
    return result.session.id;
  }

  async function deleteSelectedSession(): Promise<void> {
    const sessionId = selectedId.value;
    if (!sessionId) {
      return;
    }
    await sessionsApi.remove(sessionId);
    deselectSession();
    await refresh();
  }

  function _subscribeTurnStream(sessionId: string, turnId: string): void {
    const es = sessionsApi.openTurnStream(sessionId, turnId);
    const chunks: string[] = [];

    es.addEventListener("chunk", (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as { chunk: string };
        chunks.push(ev.chunk);
        if (active.value?.id === sessionId) {
          active.value = { ...active.value, streamingText: chunks.join("") };
        }
      } catch { /* ignore */ }
    });

    const cleanup = () => {
      es.close();
      if (active.value?.id === sessionId) {
        active.value = { ...active.value, streamingText: null };
      }
    };

    es.addEventListener("complete", cleanup);
    es.addEventListener("turn_error", (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as TurnStreamEvent;
        if (event.type === "turn_error") {
          cleanup();
        }
      } catch {
        cleanup();
      }
    });
    es.onerror = cleanup;
  }

  function reloadTranscript(): void {
    const cur = active.value;
    if (!cur) return;
    active.value = { ...cur, transcript: [], transcriptCount: 0 };
    _openStream(cur.id, cur.mutationEpoch, 0);
  }

  function setComposerUserId(userId: string | null): void {
    const cur = active.value;
    if (!cur) return;
    active.value = { ...cur, composerUserId: userId };
  }

  return {
    list,
    selectedId,
    active,
    refresh,
    createSession,
    deleteSelectedSession,
    selectSession,
    deselectSession,
    sendMessage,
    reloadTranscript,
    setComposerUserId
  };
});

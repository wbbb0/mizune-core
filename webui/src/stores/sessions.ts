import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { SessionListItem, SessionPhase, TranscriptItem, SessionStreamEvent, TurnStreamEvent } from "@/api/types";
import { sessionsApi } from "@/api/sessions";

const SESSION_DEBUG_ENABLED = import.meta.env.DEV;

function debugSession(event: string, detail?: Record<string, unknown>): void {
  if (!SESSION_DEBUG_ENABLED) return;
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
  lastActiveAt: number;
  streamStatus: "connecting" | "connected" | "error";
  phase: SessionPhase;
  transcript: TranscriptEntry[];
  transcriptHasMore: boolean;
  transcriptLoadingMore: boolean;
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
    debugSession("refresh", { sessions: res.sessions.map((s) => s.id) });
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
        lastActiveAt: 0,
        streamStatus: "connecting",
        phase: { kind: "idle", label: "连接中" },
        transcript: [],
        transcriptHasMore: false,
        transcriptLoadingMore: false,
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
    debugSession("open_stream:created", { sessionId, mutationEpoch: epoch ?? null, transcriptCount: requestedTranscriptCount });

    es.onopen = () => {
      if (_es !== es) return;
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
          debugSession("open_stream:event", { sessionId, eventType: event.type, readyState: es.readyState });
          _handleEvent(event);
        } catch { /* malformed event */ }
      });
    }

    es.onerror = () => {
      if (_es !== es) return;
      debugSession("open_stream:onerror", { sessionId, readyState: es.readyState, currentStatus: active.value?.streamStatus ?? null });
      if (active.value?.id === sessionId) {
        active.value = { ...active.value, streamStatus: "connecting" };
      }
      _scheduleReconnect(sessionId);
    };
  }

  /** REST 拉末尾 25 条后开 SSE（REST 失败时降级为 SSE from 0） */
  async function _initTranscriptAndStream(sessionId: string, epoch?: number): Promise<void> {
    try {
      const snap = await sessionsApi.fetchTranscript(sessionId, { limit: 25 });
      const cur = active.value;
      if (!cur || cur.id !== sessionId) return; // 会话已切换，丢弃
      active.value = {
        ...cur,
        transcript: snap.items,
        transcriptCount: snap.totalCount,
        transcriptHasMore: snap.hasMore,
        transcriptLoadingMore: false
      };
      _openStream(sessionId, epoch, snap.totalCount);
    } catch {
      const cur = active.value;
      if (cur?.id === sessionId) {
        _openStream(sessionId, epoch, 0);
      }
    }
  }

  function _handleEvent(event: SessionStreamEvent): void {
    const cur = active.value;
    if (!cur) return;

    if (event.type === "session_error") {
      debugSession("handle_event:session_error", { activeSessionId: cur.id, message: event.message });
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
        lastActiveAt: event.lastActiveAt,
        phase: event.phase,
        streamStatus: "connecting",
        transcript: [],
        transcriptHasMore: false,
        transcriptLoadingMore: false,
        streamingText: null,
        composerUserId: cur.composerUserId
      };
      void _initTranscriptAndStream(cur.id, event.mutationEpoch);
      return;
    }

    if (event.type === "status") {
      active.value = {
        ...cur,
        mutationEpoch: event.mutationEpoch,
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
        // 断线重连：SSE 从当前已知 transcriptCount 起，无需重拉 REST
        _openStream(sessionId, cur?.mutationEpoch, cur?.transcriptCount);
        _reconnectDelay = Math.min(_reconnectDelay * 2, 15_000);
      }
    }, _reconnectDelay);
  }

  function _closeStream(): void {
    if (_es) { _es.close(); _es = null; }
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  }

  function selectSession(sessionId: string): void {
    if (selectedId.value === sessionId) return;
    selectedId.value = sessionId;
    const selected = list.value.find((item) => item.id === sessionId);
    _closeStream();
    active.value = {
      id: sessionId,
      type: selected?.type ?? "private",
      source: selected?.source ?? "web",
      participantUserId: selected?.participantUserId ?? "",
      participantLabel: selected?.participantLabel ?? null,
      mutationEpoch: 0,
      transcriptCount: 0,
      lastActiveAt: selected?.lastActiveAt ?? 0,
      streamStatus: "connecting",
      phase: { kind: "idle", label: "连接中" },
      transcript: [],
      transcriptHasMore: false,
      transcriptLoadingMore: false,
      streamingText: null,
      composerUserId: selected?.participantUserId ?? null
    };
    void _initTranscriptAndStream(sessionId);
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

    active.value = { ...cur, composerUserId: opts.userId };
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
    if (!sessionId) return;
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
        if (event.type === "turn_error") cleanup();
      } catch { cleanup(); }
    });
    es.onerror = cleanup;
  }

  function reloadTranscript(): void {
    const cur = active.value;
    if (!cur) return;
    active.value = {
      ...cur,
      transcript: [],
      transcriptCount: 0,
      transcriptHasMore: false,
      transcriptLoadingMore: false
    };
    void _initTranscriptAndStream(cur.id, cur.mutationEpoch);
  }

  async function loadMoreTranscript(): Promise<void> {
    const cur = active.value;
    if (!cur || !cur.transcriptHasMore || cur.transcriptLoadingMore) return;

    const sessionId = cur.id;
    const oldestIndex = cur.transcript[0]?.index ?? cur.transcriptCount;

    active.value = { ...cur, transcriptLoadingMore: true };

    try {
      const snap = await sessionsApi.fetchTranscript(sessionId, {
        beforeIndex: oldestIndex,
        limit: 25
      });
      const current = active.value;
      if (!current || current.id !== sessionId) return;
      active.value = {
        ...current,
        transcript: [...snap.items, ...current.transcript],
        transcriptHasMore: snap.hasMore,
        transcriptLoadingMore: false
      };
    } catch {
      const current = active.value;
      if (current?.id === sessionId) {
        active.value = { ...current, transcriptLoadingMore: false };
      }
    }
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
    loadMoreTranscript,
    setComposerUserId
  };
});

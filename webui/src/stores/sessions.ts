import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type {
  SessionListItem,
  SessionModeOption,
  SessionPhase,
  TranscriptItem,
  TranscriptItemPatch,
  SessionStreamEvent,
  TurnStreamEvent
} from "@/api/types";
import { sessionsApi } from "@/api/sessions";

const SESSION_DEBUG_ENABLED = import.meta.env.DEV;

function debugSession(event: string, detail?: Record<string, unknown>): void {
  if (!SESSION_DEBUG_ENABLED) return;
  console.debug("[sessions]", event, detail ?? {});
}

export interface TranscriptEntry {
  id: string;
  eventId: string;
  index: number;
  item: TranscriptItem;
}
export interface ActiveSession {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  modeId: string;
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
  const modes = ref<SessionModeOption[]>([]);
  const selectedId = ref<string | null>(null);
  const active = shallowRef<ActiveSession | null>(null);

  let _es: EventSource | null = null;
  let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let _reconnectDelay = 1000;

  async function refresh(): Promise<void> {
    const [sessionRes, modeRes] = await Promise.all([
      sessionsApi.list(),
      sessionsApi.listModes()
    ]);
    list.value = sessionRes.sessions;
    modes.value = modeRes.modes;
    debugSession("refresh", { sessions: sessionRes.sessions.map((s) => s.id), modes: modeRes.modes.map((m) => m.id) });
  }

  function applyTranscriptPatch(
    transcript: TranscriptEntry[],
    itemId: string,
    patch: TranscriptItemPatch
  ): TranscriptEntry[] {
    let changed = false;
    const next = transcript.map((entry) => {
      if (entry.id !== itemId) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        item: {
          ...entry.item,
          ...patch
        }
      };
    });
    return changed ? next : transcript;
  }

  function dedupeTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
    const seen = new Set<string>();
    const deduped: TranscriptEntry[] = [];
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      deduped.push(entry);
    }
    return deduped;
  }

  function toTranscriptEntry(input: { eventId: string; index: number; item: TranscriptItem }): TranscriptEntry {
    return {
      id: input.item.id,
      eventId: input.eventId,
      index: input.index,
      item: input.item
    };
  }

  function applyLocalTranscriptInvalidation(itemIds: string[], reason: "manual_single" | "manual_group"): void {
    if (itemIds.length === 0 || !active.value) {
      return;
    }
    const touchedIds = new Set(itemIds);
    const invalidatedAt = Date.now();
    active.value = {
      ...active.value,
      transcript: active.value.transcript.map((entry) => (
        touchedIds.has(entry.id)
          ? {
              ...entry,
              item: {
                ...entry.item,
                invalidated: true,
                invalidatedAt: entry.item.invalidatedAt ?? invalidatedAt,
                invalidationReason: entry.item.invalidationReason ?? reason
              }
            }
          : entry
      ))
    };
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
        modeId: "rp_assistant",
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

    for (const eventType of ["ready", "reset", "status", "transcript_item_added", "transcript_item_patched", "session_error"] as const) {
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
        transcript: snap.items.map((item) => toTranscriptEntry(item)),
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
        modeId: event.modeId,
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
        modeId: event.modeId,
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
        modeId: event.modeId,
        lastActiveAt: event.lastActiveAt,
        phase: event.phase
      };
      return;
    }

    if (event.type === "transcript_item_added") {
      const already = cur.transcript.some((entry) => entry.id === event.item.id);
      if (already) {
        return;
      }
      const transcript = [
        ...cur.transcript,
        {
          id: event.item.id,
          eventId: event.item.id,
          index: event.index,
          item: event.item
        }
      ];
      const isAssistantMessage = event.item.kind === "assistant_message";
      active.value = {
        ...cur,
        transcript,
        transcriptCount: event.totalCount,
        ...(isAssistantMessage ? { streamingText: null } : {})
      };
      return;
    }

    if (event.type === "transcript_item_patched") {
      const transcript = applyTranscriptPatch(cur.transcript, event.itemId, event.patch);
      if (transcript !== cur.transcript) {
        active.value = {
          ...cur,
          transcript
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
      modeId: selected?.modeId ?? "rp_assistant",
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
    attachmentIds?: string[];
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
      imageIds: opts.imageIds,
      attachmentIds: opts.attachmentIds
    });
    _subscribeTurnStream(sessionId, turnId);
  }

  async function createSession(input: {
    participantUserId: string;
    participantLabel?: string;
    modeId?: string;
  }): Promise<string> {
    const result = await sessionsApi.create(input);
    await refresh();
    selectSession(result.session.id);
    return result.session.id;
  }

  async function switchSessionMode(sessionId: string, modeId: string): Promise<void> {
    const result = await sessionsApi.switchMode(sessionId, { modeId });
    list.value = list.value.map((item) => item.id === sessionId ? result.session : item);
    if (active.value?.id === sessionId) {
      active.value = {
        ...active.value,
        modeId: result.session.modeId
      };
    }
  }

  async function deleteSelectedSession(): Promise<void> {
    const sessionId = selectedId.value;
    if (!sessionId) return;
    await sessionsApi.remove(sessionId);
    deselectSession();
    await refresh();
  }

  async function deleteSession(sessionId: string): Promise<void> {
    await sessionsApi.remove(sessionId);
    if (selectedId.value === sessionId) {
      deselectSession();
    }
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
        transcript: dedupeTranscriptEntries([
          ...snap.items.map((item) => toTranscriptEntry(item)),
          ...current.transcript
        ]),
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

  async function invalidateTranscriptItem(itemId: string): Promise<void> {
    const cur = active.value;
    if (!cur) {
      return;
    }
    const result = await sessionsApi.invalidateTranscriptItem(cur.id, itemId);
    applyLocalTranscriptInvalidation(result.invalidatedItemIds, "manual_single");
  }

  async function invalidateTranscriptGroup(groupId: string): Promise<void> {
    const cur = active.value;
    if (!cur) {
      return;
    }
    const result = await sessionsApi.invalidateTranscriptGroup(cur.id, groupId);
    applyLocalTranscriptInvalidation(result.invalidatedItemIds, "manual_group");
  }

  return {
    list,
    modes,
    selectedId,
    active,
    refresh,
    createSession,
    deleteSelectedSession,
    deleteSession,
    switchSessionMode,
    selectSession,
    deselectSession,
    sendMessage,
    reloadTranscript,
    loadMoreTranscript,
    setComposerUserId,
    invalidateTranscriptItem,
    invalidateTranscriptGroup
  };
});

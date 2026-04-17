import { api } from "./client";
import type {
  ScenarioHostSessionState,
  SessionDetailResult,
  SessionListItem,
  SessionModeOption,
  TranscriptFetchResult
} from "./types";

export const sessionsApi = {
  list(): Promise<{ sessions: SessionListItem[] }> {
    return api.get("/api/sessions");
  },

  sendText(body: {
    userId?: string;
    groupId?: string;
    text: string;
  }): Promise<{ ok: boolean; result: unknown }> {
    return api.post("/api/send-text", body);
  },

  create(body: {
    participantUserId: string;
    participantLabel?: string;
    modeId?: string;
  }): Promise<{ ok: boolean; session: SessionListItem }> {
    return api.post("/api/sessions", body);
  },

  listModes(): Promise<{ modes: SessionModeOption[] }> {
    return api.get("/api/session-modes");
  },

  switchMode(sessionId: string, body: {
    modeId: string;
  }): Promise<{ ok: boolean; session: SessionListItem }> {
    return api.patch(`/api/sessions/${encodeURIComponent(sessionId)}/mode`, body);
  },

  remove(sessionId: string): Promise<{ ok: boolean }> {
    return api.delete(`/api/sessions/${encodeURIComponent(sessionId)}`);
  },

  fetchDetail(sessionId: string): Promise<SessionDetailResult> {
    return api.get(`/api/sessions/${encodeURIComponent(sessionId)}`);
  },

  updateModeState(sessionId: string, body: {
    state: ScenarioHostSessionState;
  }): Promise<{ ok: boolean; modeState: { kind: "scenario_host"; state: ScenarioHostSessionState } }> {
    return api.patch(`/api/sessions/${encodeURIComponent(sessionId)}/mode-state`, body);
  },

  sendTurn(sessionId: string, body: {
    userId: string;
    senderName?: string;
    text: string;
    imageIds?: string[];
    attachmentIds?: string[];
  }): Promise<{ ok: boolean; turnId: string }> {
    return api.post(`/api/sessions/${encodeURIComponent(sessionId)}/web-turn`, body);
  },

  /** Returns a raw EventSource; caller must close it. */
  openStream(sessionId: string, params: {
    mutationEpoch?: number;
    transcriptCount?: number;
  }): EventSource {
    const qs = new URLSearchParams();
    if (params.mutationEpoch != null) qs.set("mutationEpoch", String(params.mutationEpoch));
    if (params.transcriptCount != null) qs.set("transcriptCount", String(params.transcriptCount));
    const query = qs.toString();
    return api.sse(`/api/sessions/${encodeURIComponent(sessionId)}/stream${query ? `?${query}` : ""}`);
  },

  openTurnStream(sessionId: string, turnId: string): EventSource {
    return api.sse(
      `/api/sessions/${encodeURIComponent(sessionId)}/web-turn/stream?turnId=${encodeURIComponent(turnId)}`
    );
  },

  fetchTranscript(sessionId: string, params: {
    beforeIndex?: number;
    limit?: number;
  }): Promise<TranscriptFetchResult> {
    const qs = new URLSearchParams();
    if (params.beforeIndex != null) qs.set("beforeIndex", String(params.beforeIndex));
    if (params.limit != null) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return api.get(`/api/sessions/${encodeURIComponent(sessionId)}/transcript${query ? `?${query}` : ""}`);
  }
};

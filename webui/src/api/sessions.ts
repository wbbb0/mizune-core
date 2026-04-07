import { api } from "./client";
import type { SessionListItem } from "./types";

export const sessionsApi = {
  list(): Promise<{ sessions: SessionListItem[] }> {
    return api.get("/api/sessions");
  },

  create(body: {
    participantUserId: string;
    participantLabel?: string;
  }): Promise<{ ok: boolean; session: SessionListItem }> {
    return api.post("/api/sessions", body);
  },

  remove(sessionId: string): Promise<{ ok: boolean }> {
    return api.delete(`/api/sessions/${encodeURIComponent(sessionId)}`);
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
  }
};

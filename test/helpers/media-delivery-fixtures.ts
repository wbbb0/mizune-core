import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import type { AppConfig } from "../../src/config/config.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";

/** Real session mutations with an array view for media-tool integration assertions. */
export function createMediaTestSessions(config: AppConfig, sessionIds: string[], transcript: InternalTranscriptItem[]) {
  const manager = new SessionManager(config);
  for (const id of sessionIds) {
    manager.ensureSession({ id, type: id.includes(":g:") ? "group" : "private" });
    manager.subscribeSession(id, () => {
      transcript.splice(0, transcript.length, ...sessionIds.flatMap(sessionId => manager.getSession(sessionId).internalTranscript));
    });
  }
  return manager;
}

export function deferredMediaQueue(tasks: Array<() => Promise<void>>) {
  return { enqueueText(job: { send: () => Promise<void> }) {
    return new Promise<boolean>((resolve, reject) => {
      tasks.push(async () => {
        try { await job.send(); resolve(true); }
        catch (error) { reject(error); throw error; }
      });
    });
  } };
}

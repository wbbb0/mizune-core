import type { StoredAudioFile } from "#audio/audioStore.ts";
import type { InternalTranscriptItem, SessionState } from "#conversation/session/sessionTypes.ts";
import type { ChatFileRecord } from "#services/workspace/types.ts";
import {
  audioTranscriptionToDerivedObservation,
  chatFileCaptionToDerivedObservation,
  historySummaryToDerivedObservation,
  sessionTitleToDerivedObservation,
  transcriptToolObservationsToDerivedObservations,
  type DerivedObservation
} from "./derivedObservation.ts";
import type { PromptAudioTranscription } from "#llm/prompt/promptTypes.ts";

export interface DerivedObservationReaderDeps {
  chatFileStore?: {
    getMany(fileIds: string[]): Promise<ChatFileRecord[]>;
  } | undefined;
  audioStore?: {
    getMany(audioIds: string[]): Promise<StoredAudioFile[]>;
  } | undefined;
  sessionManager?: {
    getSession(sessionId: string): SessionState;
  } | undefined;
}

export interface DerivedObservationReadQuery {
  chatFileIds?: string[] | undefined;
  audioIds?: string[] | undefined;
  sessionIds?: string[] | undefined;
  sessions?: Array<Pick<SessionState, "id" | "title" | "titleSource" | "historySummary" | "lastActiveAt" | "internalTranscript">> | undefined;
  transcript?: readonly InternalTranscriptItem[] | undefined;
}

export class DerivedObservationReader {
  constructor(private readonly deps: DerivedObservationReaderDeps) {}

  async read(query: DerivedObservationReadQuery): Promise<DerivedObservation[]> {
    const observations: DerivedObservation[] = [];
    const [chatFiles, audioFiles] = await Promise.all([
      this.readChatFiles(query.chatFileIds ?? []),
      this.readAudioFiles(query.audioIds ?? [])
    ]);

    observations.push(...chatFiles.map(chatFileCaptionToDerivedObservation));
    observations.push(...audioFiles.map(audioTranscriptionToDerivedObservation));

    const sessions = [
      ...(query.sessions ?? []),
      ...this.readSessions(query.sessionIds ?? [])
    ];
    for (const session of sessions) {
      observations.push(sessionTitleToDerivedObservation(session));
      observations.push(historySummaryToDerivedObservation(session));
      observations.push(...transcriptToolObservationsToDerivedObservations(session.internalTranscript));
    }

    if (query.transcript) {
      observations.push(...transcriptToolObservationsToDerivedObservations(query.transcript));
    }

    return observations;
  }

  private async readChatFiles(fileIds: string[]): Promise<ChatFileRecord[]> {
    const ids = uniqueIds(fileIds);
    if (ids.length === 0 || !this.deps.chatFileStore) {
      return [];
    }
    return this.deps.chatFileStore.getMany(ids);
  }

  private async readAudioFiles(audioIds: string[]): Promise<StoredAudioFile[]> {
    const ids = uniqueIds(audioIds);
    if (ids.length === 0 || !this.deps.audioStore) {
      return [];
    }
    return this.deps.audioStore.getMany(ids);
  }

  private readSessions(sessionIds: string[]): SessionState[] {
    const ids = uniqueIds(sessionIds);
    if (ids.length === 0 || !this.deps.sessionManager) {
      return [];
    }
    return ids.map((sessionId) => this.deps.sessionManager!.getSession(sessionId));
  }
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

export function imageCaptionMapFromDerivedObservations(
  observations: readonly DerivedObservation[]
): Map<string, string> {
  return new Map(
    observations
      .filter((item) => item.sourceKind === "chat_file" && item.purpose === "image_caption" && item.status === "ready" && typeof item.text === "string" && item.text.length > 0)
      .map((item) => [item.sourceId, item.text as string])
  );
}

export function audioTranscriptionsFromDerivedObservations(
  observations: readonly DerivedObservation[],
  audioIds: readonly string[]
): PromptAudioTranscription[] {
  const byAudioId = new Map(
    observations
      .filter((item) => item.sourceKind === "audio" && item.purpose === "audio_transcription")
      .map((item) => [item.sourceId, item])
  );
  const results: PromptAudioTranscription[] = [];
  for (const audioId of uniqueIds([...audioIds])) {
    const observation = byAudioId.get(audioId);
    if (!observation) {
      continue;
    }
    if (observation.status === "ready") {
      results.push({
        audioId,
        status: "ready" as const,
        text: observation.text ?? ""
      });
      continue;
    }
    results.push({
      audioId,
      status: "failed" as const,
      error: observation.error ?? null
    });
  }
  return results;
}

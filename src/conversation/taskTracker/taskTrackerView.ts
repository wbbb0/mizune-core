import type { SessionTaskTracker, TaskEvidenceCheckpoint } from "./taskTrackerTypes.ts";

export function projectTaskTrackerForSessionView(tracker: SessionTaskTracker): SessionTaskTracker {
  return {
    ...structuredClone(tracker),
    evidence: tracker.evidence.map(projectEvidenceForSessionView)
  };
}

function projectEvidenceForSessionView(evidence: TaskEvidenceCheckpoint): TaskEvidenceCheckpoint {
  const { replayContent: _replayContent, canonicalContent: _canonicalContent, ...rest } = evidence;
  return rest;
}

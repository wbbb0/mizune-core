import test from "node:test";
import assert from "node:assert/strict";
import type { InternalTranscriptItem, SessionPhase } from "../../src/conversation/session/sessionTypes.ts";
import {
  diffSessionStreamEvents,
  type WebSessionStreamSnapshot
} from "../../src/internalApi/application/webSessionStream.ts";

const idlePhase: SessionPhase = { kind: "idle" };

function createUserMessage(id: string, timestampMs: number): InternalTranscriptItem {
  return {
    id,
    groupId: `group:${id}`,
    kind: "user_message",
    role: "user",
    llmVisible: true,
    chatType: "private",
    userId: "user-1",
    senderName: "User",
    text: `message ${id}`,
    imageIds: [],
    emojiIds: [],
    attachments: [],
    audioCount: 0,
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs
  };
}

function createSnapshot(transcriptIds: string[]): WebSessionStreamSnapshot {
  return {
    sessionId: "web:1",
    modeId: "rp_assistant",
    mutationEpoch: 0,
    transcript: transcriptIds.map((id, index) => createUserMessage(id, index + 1)),
    lastActiveAt: 1000,
    phase: idlePhase,
    activeAssistantResponseText: null
  };
}

test("session stream diffs reset gaps, append aligned items, and patch aligned items", () => {
  const previous = createSnapshot(Array.from({ length: 160 }, (_, index) => String(index + 1)));
  const current = createSnapshot(Array.from({ length: 160 }, (_, index) => String(index + 2)));

  const resetEvents = diffSessionStreamEvents(previous, current);

  assert.equal(resetEvents[0]?.type, "reset");
  assert.equal(resetEvents[0]?.type === "reset" ? resetEvents[0].reason : null, "transcript_gap_detected");

  const appendPrevious = createSnapshot(["1", "2"]);
  const appendCurrent = createSnapshot(["1", "2", "3"]);

  const appendEvents = diffSessionStreamEvents(appendPrevious, appendCurrent);

  assert.deepEqual(appendEvents.map((event) => event.type), ["transcript_item_added"]);
  const added = appendEvents[0];
  assert.equal(added?.type, "transcript_item_added");
  if (added?.type !== "transcript_item_added") {
    return;
  }
  assert.equal(added.index, 2);
  assert.equal(added.item.id, "3");

  const patchPrevious = createSnapshot(["1"]);
  const patchCurrent = createSnapshot(["1"]);
  patchCurrent.transcript[0] = {
    ...patchCurrent.transcript[0]!,
    runtimeExcluded: true,
    runtimeExcludedAt: 2000,
    runtimeExclusionReason: "manual_single"
  };

  const patchEvents = diffSessionStreamEvents(patchPrevious, patchCurrent);

  assert.deepEqual(patchEvents.map((event) => event.type), ["transcript_item_patched"]);
  const patched = patchEvents[0];
  assert.equal(patched?.type, "transcript_item_patched");
  if (patched?.type !== "transcript_item_patched") {
    return;
  }
  assert.equal(patched.itemId, "1");
  assert.deepEqual(patched.patch, {
    runtimeExcluded: true,
    runtimeExcludedAt: 2000,
    runtimeExclusionReason: "manual_single"
  });
});

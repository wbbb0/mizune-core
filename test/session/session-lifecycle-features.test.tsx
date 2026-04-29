import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

  test("completeResponse only applies to the current response epoch", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });

    const first = sessionManager.beginSyntheticGeneration(sessionId);
    const second = sessionManager.beginSyntheticGeneration(sessionId);
    sessionManager.setInterruptibleGroupTriggerUser(sessionId, "owner");

    assert.equal(sessionManager.completeResponse(sessionId, first.responseEpoch), false);
    assert.equal(sessionManager.getSession(sessionId).phase.kind, "requesting_llm");
    assert.equal(sessionManager.completeResponse(sessionId, second.responseEpoch), true);

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.phase.kind, "idle");
    assert.equal(session.responseAbortController, null);
    assert.equal(session.interruptibleGroupTriggerUserId, null);
  });

  test("epoch-guarded session mutations reject stale epochs after clear", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    const oldEpoch = sessionManager.getMutationEpoch(sessionId);

    sessionManager.clearSession(sessionId);

    assert.equal(sessionManager.setSessionPhaseIfEpochMatches(sessionId, oldEpoch, { kind: "reasoning" }), false);
    assert.equal(
      sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, oldEpoch, {
        kind: "status_message",
        llmVisible: false,
        role: "assistant",
        statusType: "system",
        content: "stale",
        timestampMs: 1
      }),
      false
    );
    assert.equal(
      sessionManager.setLastLlmUsageIfEpochMatches(sessionId, oldEpoch, {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: null,
        reasoningTokens: null,
        totalTokens: 2,
        requestCount: 1,
        providerReported: true,
        modelRef: "main",
        model: "fake",
        capturedAt: 1
      }),
      false
    );
  });

  test("session history backfill boundary is initialized and advanced by clear and compression", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    const createdBoundary = sessionManager.getSession(sessionId).historyBackfillBoundaryMs;
    assert.ok(createdBoundary > 0);

    sessionManager.getSession(sessionId).historyBackfillBoundaryMs = 1;
    sessionManager.clearSession(sessionId);
    assert.ok(sessionManager.getSession(sessionId).historyBackfillBoundaryMs >= createdBoundary);

    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "old"
    }, 10);
    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "retained"
    }, 20);
    const revision = sessionManager.getHistoryRevision(sessionId);
    assert.equal(sessionManager.applyCompressedHistoryIfHistoryRevisionMatches(sessionId, revision, {
      historySummary: "old summary",
      transcriptStartIndexToKeep: 1
    }), true);
    assert.equal(sessionManager.getSession(sessionId).historyBackfillBoundaryMs, 20);
  });

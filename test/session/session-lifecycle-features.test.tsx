import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";

  test("completeResponse only applies to the current response epoch", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });

    const first = sessionManager.beginSyntheticGeneration(sessionId);
    const second = sessionManager.beginSyntheticGeneration(sessionId);

    assert.equal(sessionManager.completeResponse(sessionId, first.responseEpoch), false);
    assert.equal(sessionManager.getSession(sessionId).phase.kind, "requesting_llm");
    assert.equal(sessionManager.completeResponse(sessionId, second.responseEpoch), true);

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.phase.kind, "idle");
    assert.equal(session.responseAbortController, null);
    assert.equal(session.currentReplyTarget, null);
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

  test("queued group reply targets are deduped by internal user id and promoted in first-trigger order", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:g:test";
    sessionManager.ensureSession({ id: sessionId, type: "group" });

    sessionManager.enqueueGroupReplyTarget(sessionId, createGroupMessage("u_a", "Alice", "A1"));
    sessionManager.enqueueGroupReplyTarget(sessionId, createGroupMessage("u_b", "Bob", "B1"));
    sessionManager.enqueueGroupReplyTarget(sessionId, createGroupMessage("u_a", "Alice", "A2"));
    sessionManager.enqueueGroupReplyTarget(sessionId, createGroupMessage("u_b", "Bob", "B2"));

    let session = sessionManager.getSession(sessionId);
    assert.equal(session.queuedGroupReplyTargets.length, 2);
    assert.deepEqual(session.queuedGroupReplyTargets.map((item) => item.userId), ["u_a", "u_b"]);
    assert.deepEqual(session.queuedGroupReplyTargets.map((item) => item.messages.map((message) => message.text)), [["A1", "A2"], ["B1", "B2"]]);
    assert.notEqual(session.queuedGroupReplyTargets[0]?.transcriptGroupId, session.queuedGroupReplyTargets[1]?.transcriptGroupId);
    const firstTranscriptGroupId = session.queuedGroupReplyTargets[0]?.transcriptGroupId;

    assert.equal(sessionManager.promoteNextQueuedGroupReplyTarget(sessionId), 2);
    session = sessionManager.getSession(sessionId);
    assert.deepEqual(session.pendingMessages.map((message) => `${message.userId}:${message.text}`), ["u_a:A1", "u_a:A2"]);
    assert.equal(session.pendingTranscriptGroupId, firstTranscriptGroupId);
    assert.deepEqual(session.queuedGroupReplyTargets.map((item) => item.userId), ["u_b"]);
  });

  function createGroupMessage(userId: string, senderName: string, text: string) {
    return {
      chatType: "group" as const,
      userId,
      groupId: "test",
      senderName,
      text,
      images: [],
      audioSources: [],
      audioIds: [],
      emojiSources: [],
      imageIds: [],
      emojiIds: [],
      attachments: [],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: true
    };
  }

  test("interruptResponse closes unfinished assistant tool calls with synthetic tool results", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    const generation = sessionManager.beginSyntheticGeneration(sessionId);
    const expectedEpoch = sessionManager.getMutationEpoch(sessionId);

    assert.equal(sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, {
      kind: "assistant_tool_call",
      llmVisible: true,
      timestampMs: 10,
      content: "",
      toolCalls: [
        {
          id: "call_done",
          type: "function",
          function: {
            name: "terminal_run",
            arguments: "{\"cmd\":\"pwd\"}"
          }
        },
        {
          id: "call_interrupted",
          type: "function",
          function: {
            name: "terminal_run",
            arguments: "{\"cmd\":\"sleep 10\"}"
          }
        }
      ]
    }), true);
    assert.equal(sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 11,
      toolCallId: "call_done",
      toolName: "terminal_run",
      content: "{\"stdout\":\"/repo\"}"
    }), true);

    const groupId = sessionManager.getSession(sessionId).activeTranscriptGroupId;
    assert.ok(groupId);
    const interrupted = sessionManager.interruptResponse(sessionId);

    assert.equal(interrupted.cancelledGeneration, true);
    assert.equal(generation.abortController.signal.aborted, true);
    const toolResults = sessionManager.getSession(sessionId).internalTranscript
      .filter((item) => item.kind === "tool_result" && item.groupId === groupId);
    assert.equal(toolResults.length, 2);
    const synthetic = toolResults.find((item) => item.kind === "tool_result" && item.toolCallId === "call_interrupted");
    assert.equal(synthetic?.kind, "tool_result");
    assert.equal(synthetic?.toolName, "terminal_run");
    assert.match(synthetic?.content ?? "", /工具调用被用户新消息打断/);
    assert.equal(
      sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, {
        kind: "tool_result",
        llmVisible: true,
        timestampMs: 12,
        toolCallId: "call_late",
        toolName: "terminal_run",
        content: "{\"stdout\":\"late\"}"
      }),
      false
    );
  });

  test("finishing a profile operation preserves transcript and appends a visible phase marker", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "设定前的上下文"
    }, 10);
    sessionManager.setOperationMode(sessionId, {
      kind: "persona_config",
      draft: createEmptyPersona()
    });
    const oldEpoch = sessionManager.getMutationEpoch(sessionId);

    assert.equal(sessionManager.finishProfileOperation(sessionId, {
      action: "exit_confirmed",
      source: "command"
    }), true);

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.operationMode.kind, "normal");
    assert.ok(session.mutationEpoch > oldEpoch);
    assert.equal(session.internalTranscript.length, 2);
    assert.equal(session.internalTranscript[0]?.kind, "user_message");
    const marker = session.internalTranscript[1];
    assert.equal(marker?.kind, "profile_phase_transition");
    if (marker?.kind === "profile_phase_transition") {
      assert.equal(marker.llmVisible, true);
      assert.equal(marker.target, "persona");
      assert.equal(marker.phase, "config");
      assert.equal(marker.action, "exit_confirmed");
      assert.match(marker.content, /profile_phase_transition/);
    }
    assert.equal(sessionManager.getLlmVisibleHistory(sessionId).length, 2);
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

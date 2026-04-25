import test from "node:test";
import assert from "node:assert/strict";
import { DerivedObservationReader } from "../../src/llm/derivations/derivedObservationReader.ts";
import { buildToolObservation } from "../../src/conversation/session/toolObservation.ts";
import type { InternalTranscriptItem, SessionState } from "../../src/conversation/session/sessionTypes.ts";

test("derived observation reader exposes media, session, history, and tool observations", async () => {
  const toolObservation = buildToolObservation({
    toolName: "local_file_read",
    toolCallId: "tool-1",
    content: JSON.stringify({
      path: "src/index.ts",
      content: "入口文件",
      startLine: 1,
      endLine: 10
    })
  });
  const transcript: InternalTranscriptItem[] = [{
    kind: "tool_result",
    llmVisible: true,
    timestampMs: 30,
    toolCallId: "tool-1",
    toolName: "local_file_read",
    content: "{}",
    observation: toolObservation
  }];
  const session = {
    id: "qqbot:p:test",
    title: "测试会话",
    titleSource: "auto",
    historySummary: "用户在检查派生观察读模型。",
    internalTranscript: transcript,
    lastActiveAt: 40
  } as SessionState;
  const reader = new DerivedObservationReader({
    chatFileStore: {
      async getMany(fileIds) {
        assert.deepEqual(fileIds, ["file_1"]);
        return [{
          fileId: "file_1",
          fileRef: "chat_1.png",
          kind: "image",
          origin: "chat_message",
          chatFilePath: "chat-files/media/chat_1.png",
          sourceName: "chat_1.png",
          mimeType: "image/png",
          sizeBytes: 123,
          createdAtMs: 10,
          sourceContext: {},
          caption: "一张截图",
          captionStatus: "ready",
          captionModelRef: "vision-model",
          captionUpdatedAtMs: 11,
          captionError: null
        }];
      }
    },
    audioStore: {
      async getMany(audioIds) {
        assert.deepEqual(audioIds, ["aud_1"]);
        return [{
          id: "aud_1",
          source: "https://example.com/a.mp3",
          createdAt: 20,
          transcription: "你好",
          transcriptionStatus: "ready",
          transcriptionUpdatedAt: 21,
          transcriptionModelRef: "audio-model",
          transcriptionError: null
        }];
      }
    }
  });

  const observations = await reader.read({
    chatFileIds: ["file_1", "file_1"],
    audioIds: ["aud_1"],
    sessions: [session]
  });

  assert.equal(observations.length, 5);
  assert.deepEqual(observations.map((item) => item.purpose), [
    "image_caption",
    "audio_transcription",
    "session_title",
    "history_summary",
    "tool_replay_compaction"
  ]);
  assert.equal(observations[0]?.modelRef, "vision-model");
  assert.equal(observations[1]?.modelRef, "audio-model");
  assert.equal(observations[2]?.text, "测试会话");
  assert.equal(observations[3]?.text, "用户在检查派生观察读模型。");
  assert.equal(observations[4]?.sourceHash, toolObservation.contentHash);
});

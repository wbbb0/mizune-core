import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationSegmentCoordinator } from "../../src/app/generation/generationSegmentCoordinator.ts";

test("segment coordinator does not mark skipped chunks as committed", async () => {
  const committedMarks: string[] = [];
  const draftDeltas: string[] = [];
  const draftStates: string[] = [];
  const coordinator = createGenerationSegmentCoordinator({
    disableStreamingSplit: false,
    committedSink: {
      async enqueueChunk() {
        return false;
      },
      async flushBufferedOutput(_summary, streamBuffer) {
        return streamBuffer;
      }
    },
    draftOverlaySink: {
      appendDelta(delta) {
        draftDeltas.push(delta);
      },
      markCommitted() {
        committedMarks.push("committed");
      },
      complete() {},
      fail() {}
    },
    draftStateSink: {
      replaceDraftText(text) {
        draftStates.push(text);
      },
      clearDraftText() {
        draftStates.push("<clear>");
      }
    }
  });

  await coordinator.onTextDelta("第一段已经足够长而且可以分割。");

  assert.deepEqual(draftDeltas, ["第一段已经足够长而且可以分割。"]);
  assert.deepEqual(committedMarks, []);
  assert.deepEqual(draftStates, ["第一段已经足够长而且可以分割。"]);
});

test("segment coordinator keeps only uncommitted streamed draft text after a paragraph split commit", async () => {
  const committedChunks: string[] = [];
  const draftStates: string[] = [];
  const coordinator = createGenerationSegmentCoordinator({
    disableStreamingSplit: false,
    committedSink: {
      async enqueueChunk(chunk) {
        committedChunks.push(chunk);
        return true;
      },
      async flushBufferedOutput(_summary, streamBuffer) {
        return streamBuffer;
      }
    },
    draftOverlaySink: {
      appendDelta() {},
      markCommitted() {},
      complete() {},
      fail() {}
    },
    draftStateSink: {
      replaceDraftText(text) {
        draftStates.push(text);
      },
      clearDraftText() {
        draftStates.push("<clear>");
      }
    }
  });

  await coordinator.onTextDelta("第一段已经足够长而且可以分割。\n\n后面这点还没结束");

  assert.deepEqual(committedChunks, ["第一段已经足够长而且可以分割。"]);
  assert.deepEqual(draftStates, [
    "第一段已经足够长而且可以分割。\n\n后面这点还没结束",
    "后面这点还没结束"
  ]);
});

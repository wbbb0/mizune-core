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

test("segment coordinator flushes only the uncommitted summary tail after streamed commits", async () => {
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
  await coordinator.flushSummary("第一段已经足够长而且可以分割。\n\n后面这点还没结束。", true);

  assert.deepEqual(committedChunks, [
    "第一段已经足够长而且可以分割。",
    "后面这点还没结束。"
  ]);
  assert.equal(coordinator.getCommittedText(), "第一段已经足够长而且可以分割。\n\n后面这点还没结束。");
  assert.equal(draftStates[draftStates.length - 1], "<clear>");
});

test("segment coordinator never treats a mismatched final summary as an unsent tail", async () => {
  const committedChunks: string[] = [];
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
    }
  });

  await coordinator.onTextDelta("流式发送的第一段已经足够长。\n\n仍在缓冲的第二段");
  await coordinator.flushSummary("Provider 归一化后的完整原文，与流式前缀并不完全相同。", true);

  assert.deepEqual(committedChunks, [
    "流式发送的第一段已经足够长。",
    "仍在缓冲的第二段"
  ]);
});

test("segment coordinator keeps a buffered tail when the final summary stops at the committed prefix", async () => {
  const committedChunks: string[] = [];
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
    }
  });

  const committedPrefix = "流式发送的第一段已经足够长。";
  await coordinator.onTextDelta(`${committedPrefix}\n\n晚到但仍需发送的尾部`);
  await coordinator.flushSummary(committedPrefix, true);

  assert.deepEqual(committedChunks, [committedPrefix, "晚到但仍需发送的尾部"]);
});

test("segment coordinator exposes committed text as the provider assistant replay content", async () => {
  const committedChunks: string[] = [];
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
    }
  });

  await coordinator.onTextDelta("看看便知。");
  await coordinator.flushBufferedChunk();

  assert.deepEqual(committedChunks, ["看看便知。"]);
  assert.equal(coordinator.resolveProviderAssistantText("看看便知。\n\n看看便知。"), "看看便知。");

  await coordinator.onTextDelta("继续查。");
  await coordinator.flushBufferedChunk();

  assert.deepEqual(committedChunks, ["看看便知。", "继续查。"]);
  assert.equal(coordinator.resolveProviderAssistantText("看看便知。\n\n继续查。"), "继续查。");
});

test("segment coordinator drops duplicate buffered tool-call text after streamed split", async () => {
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
    draftStateSink: {
      replaceDraftText(text) {
        draftStates.push(text);
      },
      clearDraftText() {
        draftStates.push("<clear>");
      }
    }
  });

  const text = "确实已经没了。起个跑30次的，跑完会自动触发通知。";
  await coordinator.onTextDelta(`${text}\n\n${text}`);
  await coordinator.flushBufferedChunk();

  assert.deepEqual(committedChunks, [text]);
  assert.equal(coordinator.resolveProviderAssistantText(`${text}\n\n${text}`), text);
  assert.equal(draftStates[draftStates.length - 1], "<clear>");
});

test("segment coordinator does not trim final summary against previous tool-call text", async () => {
  const committedChunks: string[] = [];
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
    }
  });

  await coordinator.onTextDelta("好的。");
  await coordinator.flushBufferedChunk();
  assert.equal(coordinator.resolveProviderAssistantText("好的。"), "好的。");

  await coordinator.flushSummary("好的。结果如下。", true);

  assert.deepEqual(committedChunks, ["好的。", "好的。结果如下。"]);
});

test("segment coordinator appends a standalone checkpoint after streamed tool-call text", async () => {
  const committedChunks: Array<{ text: string; doubleNewline: boolean }> = [];
  const coordinator = createGenerationSegmentCoordinator({
    disableStreamingSplit: false,
    committedSink: {
      async enqueueChunk(chunk, options) {
        committedChunks.push({ text: chunk, doubleNewline: options?.joinWithDoubleNewline === true });
        return true;
      },
      async flushBufferedOutput(_summary, streamBuffer) {
        return streamBuffer;
      }
    }
  });

  await coordinator.onTextDelta("我先检查配置。\n\n还有一段未发送说明");
  await coordinator.appendStandalone("已完成配置检查。请确认是否继续。");

  assert.deepEqual(committedChunks, [
    { text: "我先检查配置。", doubleNewline: true },
    { text: "还有一段未发送说明", doubleNewline: false },
    { text: "已完成配置检查。请确认是否继续。", doubleNewline: true }
  ]);
  assert.equal(
    coordinator.getCommittedText(),
    "我先检查配置。还有一段未发送说明\n\n已完成配置检查。请确认是否继续。"
  );
});

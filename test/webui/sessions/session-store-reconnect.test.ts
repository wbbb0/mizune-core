/// <reference path="../../../webui/src/vite-env.d.ts" />
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useSessionsStore } from "../../../webui/src/stores/sessions.ts";
import { sessionsApi } from "../../../webui/src/api/sessions.ts";
import type { TranscriptFetchResult, TranscriptItem } from "../../../webui/src/api/types.ts";

class SyntheticEventSource extends EventTarget {
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() { this.closed = true; this.readyState = 2; }
  emit(type: string, value: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) })); }
  fail() { this.onerror?.(); }
}

function item(index: number, text = `合成历史 ${index}`): TranscriptItem {
  return {
    id: `message-${index}`, groupId: "synthetic-group", runtimeExcluded: false,
    kind: "user_message", role: "user", llmVisible: true, chatType: "private",
    userId: "synthetic", senderName: "合成用户", text, imageIds: [], emojiIds: [], attachments: [], messageFiles: [],
    audioCount: 0, forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, mentionedSelf: false, timestampMs: index
  };
}

function snapshot(totalCount: number, start = Math.max(0, totalCount - 25), override?: { index: number; text: string }): TranscriptFetchResult {
  return {
    totalCount, hasMore: start > 0,
    items: Array.from({ length: totalCount - start }, (_, offset) => {
      const index = start + offset;
      return { eventId: `message-${index}`, index, item: item(index, override?.index === index ? override.text : undefined) };
    })
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(t: TestContext) {
  setActivePinia(createPinia());
  const requests: Array<{
    id: string; params: { beforeIndex?: number; limit?: number }; signal: AbortSignal | undefined;
    resolve: (snapshot: TranscriptFetchResult) => void; reject: (error: Error) => void;
  }> = [];
  const streams: Array<{ id: string; params: { mutationEpoch?: number; transcriptCount?: number }; source: SyntheticEventSource }> = [];
  t.mock.method(sessionsApi, "fetchTranscript", (id: string, params: { beforeIndex?: number; limit?: number }, signal?: AbortSignal) => (
    new Promise<TranscriptFetchResult>((resolve, reject) => { requests.push({ id, params, signal, resolve, reject }); })
  ));
  t.mock.method(sessionsApi, "openStream", (id: string, params: { mutationEpoch?: number; transcriptCount?: number }) => {
    const source = new SyntheticEventSource();
    streams.push({ id, params, source });
    return source as unknown as EventSource;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = useSessionsStore();
  t.after(() => { store.deselectSession(); store.$dispose(); });
  const ready = (streamIndex: number, totalCount: number) => {
    const stream = streams[streamIndex]!;
    stream.source.emit("ready", { type: "ready", sessionId: stream.id, modeId: "assistant", mutationEpoch: 0,
      transcriptCount: totalCount, lastActiveAt: 1, phase: { kind: "idle", label: "空闲" }, timestampMs: 1 });
  };
  const added = (streamIndex: number, index: number, totalCount: number, text?: string) => {
    const stream = streams[streamIndex]!;
    stream.source.emit("transcript_item_added", { type: "transcript_item_added", sessionId: stream.id,
      mutationEpoch: 0, index, totalCount, item: item(index, text), timestampMs: 1 });
  };
  return { store, requests, streams, ready, added };
}

test("ready and append totals cannot skip unreceived backlog across a slow SSE disconnect", async t => {
  const h = harness(t);
  h.store.selectSession("web:a");
  h.requests[0]!.resolve(snapshot(0));
  await flush();
  h.ready(0, 300);
  assert.equal(h.store.active?.transcriptCount, 0);
  h.added(0, 0, 300);
  assert.equal(h.store.active?.transcriptCount, 1);
  h.streams[0]!.source.fail();
  assert.equal(h.streams[0]!.source.closed, true);
  t.mock.timers.tick(1000);
  assert.equal(h.requests.length, 2, "reconnect must fetch a snapshot instead of trusting ready/totalCount");
  assert.equal(h.streams.length, 1);
  h.requests[1]!.resolve(snapshot(300));
  await flush();
  assert.equal(h.streams[1]!.params.transcriptCount, 275, "handshake replays the loaded tail window");
  assert.equal(h.store.active?.transcript.length, 25);
  assert.equal(h.store.active?.transcript[0]?.index, 275);
  assert.equal(h.store.active?.transcriptCount, 300);
});

test("reconnect replaces stale pages, recovers old patches and upserts REST/SSE handoff overlap", async t => {
  const h = harness(t);
  h.store.selectSession("web:a");
  h.requests[0]!.resolve(snapshot(30));
  await flush();
  h.ready(0, 30);
  const more = h.store.loadMoreTranscript();
  h.requests[1]!.resolve({ items: snapshot(5).items, totalCount: 30, hasMore: false });
  await more;
  assert.equal(h.store.active?.transcript.length, 30);
  h.streams[0]!.source.fail();
  t.mock.timers.tick(1000);
  h.requests[2]!.resolve(snapshot(30, 5, { index: 5, text: "断线期间更新" }));
  await flush();
  assert.equal(h.store.active?.transcript.length, 25, "discard loaded old pages on resynchronization");
  assert.equal(h.store.active?.transcript[0]?.item.kind, "user_message");
  assert.match(JSON.stringify(h.store.active?.transcript[0]?.item), /断线期间更新/);
  assert.equal(h.streams[1]!.params.transcriptCount, 5);
  h.added(1, 5, 30, "REST返回到订阅前更新");
  assert.equal(h.store.active?.transcript.length, 25, "overlapping replay must update rather than duplicate an item");
  assert.match(JSON.stringify(h.store.active?.transcript[0]?.item), /REST返回到订阅前更新/);
  h.streams[1]!.source.emit("transcript_item_patched", { type: "transcript_item_patched", sessionId: "web:a",
    mutationEpoch: 0, itemId: "message-5", patch: { text: "订阅后继续更新" }, timestampMs: 1 });
  assert.match(JSON.stringify(h.store.active?.transcript[0]?.item), /订阅后继续更新/);
});

test("snapshot failure explicitly discards invalid cached display and restarts from zero", async t => {
  const h = harness(t);
  h.store.selectSession("web:a");
  h.requests[0]!.resolve(snapshot(2));
  await flush();
  h.ready(0, 2);
  h.streams[0]!.source.fail();
  t.mock.timers.tick(1000);
  h.requests[1]!.reject(new Error("synthetic REST failure"));
  await flush();
  assert.equal(h.store.active?.transcriptCount, 0);
  assert.deepEqual(h.store.active?.transcript, []);
  assert.equal(h.streams[1]!.params.transcriptCount, 0);
  h.ready(1, 300);
  assert.equal(h.store.active?.transcriptCount, 0);
  h.added(1, 0, 300, "重新收到的第1条");
  assert.equal(h.store.active?.transcriptCount, 1);
  h.added(0, 1, 300, "旧连接迟到事件");
  assert.equal(h.store.active?.transcript.length, 1);
});

test("session A to B to A and deselection cancel old snapshots without reviving streams", async t => {
  const h = harness(t);
  h.store.selectSession("web:a");
  h.store.selectSession("web:b");
  h.store.selectSession("web:a");
  assert.equal(h.requests[0]!.signal?.aborted, true);
  assert.equal(h.requests[1]!.signal?.aborted, true);
  h.requests[0]!.resolve(snapshot(99));
  h.requests[1]!.resolve(snapshot(77));
  await flush();
  assert.equal(h.streams.length, 0);
  h.requests[2]!.resolve(snapshot(3));
  await flush();
  assert.equal(h.streams.length, 1);
  assert.equal(h.store.active?.transcriptCount, 3);
  h.streams[0]!.source.fail();
  t.mock.timers.tick(1000);
  h.store.deselectSession();
  assert.equal(h.requests[3]!.signal?.aborted, true);
  h.requests[3]!.resolve(snapshot(500));
  await flush();
  assert.equal(h.streams.length, 1);
  assert.equal(h.store.active, null);
});

test("pagination from before a disconnect cannot reintroduce stale pages after a fresh snapshot", async t => {
  const h = harness(t);
  h.store.selectSession("web:a");
  h.requests[0]!.resolve(snapshot(30));
  await flush();
  h.ready(0, 30);
  const more = h.store.loadMoreTranscript();
  h.streams[0]!.source.fail();
  assert.equal(h.requests[1]!.signal?.aborted, true);
  t.mock.timers.tick(1000);
  h.requests[2]!.resolve(snapshot(30, 5, { index: 5, text: "新的快照" }));
  await flush();
  h.requests[1]!.resolve({ items: snapshot(5).items, totalCount: 30, hasMore: false });
  await more;
  assert.equal(h.store.active?.transcript.length, 25);
  assert.match(JSON.stringify(h.store.active?.transcript[0]?.item), /新的快照/);
  assert.equal(h.store.active?.transcriptLoadingMore, false);
});

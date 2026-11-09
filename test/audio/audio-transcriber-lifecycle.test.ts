import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { AudioTranscriber } from "../../src/audio/audioTranscriber.ts";
import { prepareAudioInputsForModel } from "../../src/messages/audioSources.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean) {
  for (let tries = 0; !predicate(); tries++) {
    if (tries > 1000) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function harness(transcribe: (input: { abortSignal: AbortSignal }) => Promise<{ text: string; usage: { modelRef: string } }>) {
  const config = createTestAppConfig({ llm: { enabled: true, audioTranscription: { enabled: true } } });
  const files = new Map(["a", "b"].map(id => [id, {
    id, source: "data:audio/mpeg;base64,SUQz", transcriptionStatus: "missing", transcription: null as string | null, transcriptionError: null as string | null
  }]));
  const store = {
    async getMany(ids: string[]) { return ids.flatMap(id => { const file = files.get(id); return file ? [file] : []; }); },
    async get(id: string) { return files.get(id) ?? null; },
    async markTranscriptionsQueued(ids: string[], signal?: AbortSignal) { signal?.throwIfAborted(); for (const id of ids) files.get(id)!.transcriptionStatus = "queued"; },
    async saveTranscriptionSuccess(id: string, result: { transcription: string }, signal?: AbortSignal) {
      signal?.throwIfAborted(); Object.assign(files.get(id)!, { transcription: result.transcription, transcriptionStatus: "ready" });
    },
    async saveTranscriptionFailure(id: string, result: { message: string }, signal?: AbortSignal) {
      signal?.throwIfAborted(); Object.assign(files.get(id)!, { transcriptionError: result.message, transcriptionStatus: "failed" });
    },
    async clearTranscriptionQueued(id: string, unowned: () => boolean) {
      const file = files.get(id)!;
      if (unowned() && file.transcriptionStatus === "queued") file.transcriptionStatus = "missing";
    }
  };
  const service = new AudioTranscriber(config, { isCapabilityConfigured: () => true, transcribe } as any,
    store as any, { async getRecord() { throw new Error("data URLs do not need OneBot"); } }, pino({ level: "silent" }));
  return { service, files, config, store };
}

test("audio transcription sharing survives one owner's cancellation", async () => {
  const result = deferred<{ text: string; usage: { modelRef: string } }>();
  let calls = 0;
  let signal!: AbortSignal;
  const { service } = harness(async input => { calls++; signal = input.abortSignal; return result.promise; });
  const controller = new AbortController();
  const first = service.ensureReady(["a"], { abortSignal: controller.signal });
  const second = service.ensureReady(["a"]);
  await waitFor(() => calls === 1);
  controller.abort(new Error("cancel one"));
  await assert.rejects(first, /cancel one/);
  assert.equal(signal.aborted, false);
  result.resolve({ text: "共享转写", usage: { modelRef: "transcription" } });
  assert.equal((await second).get("a")?.text, "共享转写");
  await service.stop();
});

test("cancelled audio model results never overwrite newer transcriptions", async () => {
  const oldResult = deferred<{ text: string; usage: { modelRef: string } }>();
  let calls = 0;
  const { service, files } = harness(async () => ++calls === 1 ? oldResult.promise : { text: "新转写", usage: { modelRef: "transcription" } });
  const controller = new AbortController();
  const old = service.ensureReady(["a"], { abortSignal: controller.signal });
  await waitFor(() => calls === 1);
  controller.abort(new Error("superseded"));
  await assert.rejects(old, /superseded/);
  assert.equal((await service.ensureReady(["a"])).get("a")?.text, "新转写");
  oldResult.resolve({ text: "旧转写", usage: { modelRef: "transcription" } });
  await service.stop();
  assert.equal(files.get("a")?.transcription, "新转写");
  assert.equal(files.get("a")?.transcriptionStatus, "ready");
});

test("background audio owners expire and cleanup cancellation without a failed result", async () => {
  const result = deferred<{ text: string; usage: { modelRef: string } }>();
  let signal!: AbortSignal;
  const { service, files, config } = harness(async input => { signal = input.abortSignal; return result.promise; });
  config.llm.audioTranscription.timeoutMs = 20;
  service.schedule(["a"], "background test");
  await waitFor(() => Boolean(signal?.aborted));
  result.resolve({ text: "迟到结果", usage: { modelRef: "transcription" } });
  await service.stop();
  assert.equal(files.get("a")?.transcription, null);
  assert.equal(files.get("a")?.transcriptionStatus, "missing");
  assert.equal(files.get("a")?.transcriptionError, null);
});

test("audio source fetch receives cancellation and cannot advance to body handling after abort", async t => {
  const controller = new AbortController();
  let called = false;
  t.mock.method(globalThis, "fetch", (_input: unknown, options: RequestInit) => {
    assert.equal(options.signal, controller.signal);
    called = true;
    return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
  });
  const pending = prepareAudioInputsForModel(["https://synthetic.invalid/audio.mp3"], {
    oneBotClient: { async getRecord() { throw new Error("unexpected OneBot call"); } }
  }, { abortSignal: controller.signal });
  await waitFor(() => called);
  controller.abort(new Error("audio deadline"));
  await assert.rejects(pending, /audio deadline/);
});

test("audio source OneBot resolution receives the same signal and late resolution is discarded", async () => {
  const record = deferred<{ file: string | null; url: string | null }>();
  const controller = new AbortController();
  let called = false;
  const pending = prepareAudioInputsForModel(["synthetic-record"], {
    oneBotClient: { async getRecord(_source, _format, signal) { assert.equal(signal, controller.signal); called = true; return record.promise; } }
  }, { abortSignal: controller.signal });
  await waitFor(() => called);
  controller.abort(new Error("record cancelled"));
  record.resolve({ file: "data:audio/mpeg;base64,SUQz", url: null });
  await assert.rejects(pending, /record cancelled/);
});

test("cancellation behind a failed-transcription write still resets unowned queued state", async () => {
  const gate = deferred<void>();
  let waiting = false;
  const { service, files, store } = harness(async () => { throw new Error("ordinary transcription failure"); });
  const save = store.saveTranscriptionFailure.bind(store);
  store.saveTranscriptionFailure = async (id, result, signal) => {
    waiting = true;
    await gate.promise;
    return save(id, result, signal);
  };
  const controller = new AbortController();
  const pending = service.ensureReady(["a"], { abortSignal: controller.signal });
  await waitFor(() => waiting);
  controller.abort(new Error("cancel failed transcription write"));
  await assert.rejects(pending, /cancel failed transcription write/);
  gate.resolve();
  await service.stop();
  assert.equal(files.get("a")?.transcriptionStatus, "missing");
  assert.equal(files.get("a")?.transcriptionError, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { AudioStore } from "../../src/audio/audioStore.ts";

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("audio store persists records in assets sqlite without legacy json output", async () => {
  await withDataDir("llm-bot-audio-store-sqlite", async (dataDir) => {
    const store = new AudioStore(dataDir, pino({ level: "silent" }));
    await store.init();

    const [created] = await store.registerSources(["https://example.com/audio.mp3"]);
    assert.ok(created);
    assert.equal((await store.get(created.id))?.source, "https://example.com/audio.mp3");

    const assetFiles = await readdir(join(dataDir, "assets"), { withFileTypes: true });
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "assets.sqlite"), true);
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "audio-files.json"), false);
  });
});

test("audio store keeps transcription state transitions in sqlite", async () => {
  await withDataDir("llm-bot-audio-store-transcription", async (dataDir) => {
    const store = new AudioStore(dataDir, pino({ level: "silent" }));
    await store.init();

    const [created] = await store.registerSources(["https://example.com/audio.mp3"]);
    assert.ok(created);

    await store.markTranscriptionsQueued([created.id]);
    assert.equal((await store.get(created.id))?.transcriptionStatus, "queued");

    await store.saveTranscriptionSuccess(created.id, {
      transcription: "hello",
      modelRef: "main"
    });
    const saved = await store.get(created.id);
    assert.equal(saved?.transcriptionStatus, "ready");
    assert.equal(saved?.transcription, "hello");
    assert.equal(saved?.transcriptionModelRef, "main");
  });
});
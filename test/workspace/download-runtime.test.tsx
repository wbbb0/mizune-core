import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import { DownloadRuntime } from "../../src/services/workspace/downloadRuntime.ts";
import type { ChatFileRecord } from "../../src/services/workspace/types.ts";

type FakeDownloadRequest = {
  destinationPath: string;
  checkpoint?: unknown;
  signal?: AbortSignal;
  onEvent?: (event: any) => void | Promise<void>;
};

type FakeEngine = {
  probe: (...args: any[]) => Promise<any>;
  download: (request: FakeDownloadRequest) => Promise<any>;
  close: () => Promise<void>;
};

function createFakeEngine(content: Buffer | string) {
  const buffer = Buffer.from(content);
  return {
    async probe() {
      return { url: "https://example.com/file.bin", totalBytes: buffer.byteLength, acceptRanges: true, strongEtag: '"test"', lastModified: null };
    },
    async download(request: FakeDownloadRequest) {
      await request.onEvent?.({ type: "phase", phase: "probing" });
      await request.onEvent?.({ type: "phase", phase: "transferring" });
      await request.onEvent?.({ type: "progress", downloadedBytes: buffer.byteLength, totalBytes: buffer.byteLength });
      if (request.signal?.aborted) throw request.signal.reason;
      await writeFile(request.destinationPath, buffer);
      await request.onEvent?.({ type: "phase", phase: "finalizing" });
      return { finalPath: request.destinationPath, totalBytes: buffer.byteLength, strongEtag: null, lastModified: null };
    },
    async close() {}
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "llm-onebot-download-runtime-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createRuntime(
  rootDir: string,
  overrides: Parameters<typeof createTestAppConfig>[0] = {},
  engine: FakeEngine = createFakeEngine("hello world")
) {
  const config = createTestAppConfig({
    localFiles: {
      enabled: true,
      root: rootDir,
      maxPatchFileBytes: 128 * 1024
    },
    chatFiles: {
      enabled: true,
      root: "chat-files",
      maxUploadBytes: 64
    },
    ...overrides
  });
  const logger = pino({ level: "silent" });
  const localFileService = new LocalFileService(config, rootDir);
  const chatFileStore = new ChatFileStore(config, logger, localFileService);
  const runtime = new DownloadRuntime(config, logger, rootDir, chatFileStore, { engine: engine as never });
  return { runtime, chatFileStore };
}

test("download runtime imports a short download as a asset", async () => {
  await withTempDir(async (dir) => {
    const { runtime, chatFileStore } = createRuntime(dir);
    await chatFileStore.init();
    const result = await runtime.start({
      sourceUrl: "https://example.com/file.txt",
      origin: "browser_download",
      foregroundWaitMs: 1000
    });
    assert.equal(result.status, "completed");
    assert.equal(result.asset_ref?.endsWith(".txt"), true);
    assert.equal(result.source_name, "file.txt");
    assert.equal((await chatFileStore.listFiles()).length, 1);
    await runtime.close();
  });
});

test("download runtime rejects responses larger than asset limit", async () => {
  await withTempDir(async (dir) => {
    const { runtime, chatFileStore } = createRuntime(dir, {}, createFakeEngine(Buffer.alloc(65)));
    await chatFileStore.init();
    const result = await runtime.start({
      sourceUrl: "https://example.com/large.bin",
      origin: "browser_download",
      foregroundWaitMs: 1000
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /maxUploadBytes/);
    assert.deepEqual(await chatFileStore.listFiles(), []);
    await runtime.close();
  });
});

test("download runtime pauses and resumes with the latest checkpoint", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    let resumedCheckpoint: unknown = null;
    const checkpoint = {
      schemaVersion: 1 as const,
      resource: { url: "https://example.com/resume.bin", totalBytes: 4, strongEtag: '"resume"', lastModified: null },
      segments: [{ index: 0, startByte: 0, endByte: 3, downloadedBytes: 2 }]
    };
    const engine = {
      async probe() {
        return { url: checkpoint.resource.url, totalBytes: 4, acceptRanges: true, strongEtag: '"resume"', lastModified: null };
      },
      async download(request: FakeDownloadRequest) {
        calls += 1;
        if (calls === 1) {
          await request.onEvent?.({ type: "checkpoint", checkpoint });
          await new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }));
        }
        resumedCheckpoint = request.checkpoint;
        await writeFile(request.destinationPath, "data");
        await request.onEvent?.({ type: "progress", downloadedBytes: 4, totalBytes: 4 });
        return { finalPath: request.destinationPath, totalBytes: 4, strongEtag: '"resume"', lastModified: null };
      },
      async close() {}
    };
    const { runtime, chatFileStore } = createRuntime(dir, {}, engine);
    await chatFileStore.init();
    const started = await runtime.start({
      sourceUrl: checkpoint.resource.url,
      origin: "url_download",
      foregroundWaitMs: 1
    });
    assert.equal(started.status, "running");
    assert.equal((await runtime.pause(started.resource_id))?.status, "paused");
    assert.equal((await runtime.resume(started.resource_id))?.status, "running");
    await waitForDownloadStatus(runtime, started.resource_id, "completed");
    assert.deepEqual(resumedCheckpoint, checkpoint);
    assert.equal(calls, 2);
    await runtime.close();
  });
});

test("download runtime integrates the vendored HTTP engine", async () => {
  await withTempDir(async (dir) => {
    const content = Buffer.from("engine integration");
    const server = createServer((request, response) => {
      response.setHeader("content-length", String(content.byteLength));
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(content);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = createTestAppConfig({
      localFiles: { enabled: true, root: dir, maxPatchFileBytes: 128 * 1024 },
      chatFiles: { enabled: true, root: "chat-files", maxUploadBytes: 1024 }
    });
    const logger = pino({ level: "silent" });
    const chatFileStore = new ChatFileStore(config, logger, new LocalFileService(config, dir));
    const runtime = new DownloadRuntime(config, logger, dir, chatFileStore, { allowPrivateHosts: true });
    try {
      await chatFileStore.init();
      const result = await runtime.start({
        sourceUrl: `http://127.0.0.1:${address.port}/engine.txt`,
        origin: "url_download",
        foregroundWaitMs: 2000
      });
      assert.equal(result.status, "completed");
      assert.equal(result.downloaded_bytes, content.byteLength);
      assert.equal(result.asset_ref?.endsWith(".txt"), true);
    } finally {
      await runtime.close();
      server.close();
      await once(server, "close");
    }
  });
});

test("download runtime cancellation wins over a concurrent import", async () => {
  await withTempDir(async (dir) => {
    const config = createTestAppConfig({
      chatFiles: {
        enabled: true,
        root: "chat-files",
        maxUploadBytes: 1024
      }
    });
    let deletedFileId: string | null = null;
    let resolveImportStarted!: () => void;
    let releaseImport!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      resolveImportStarted = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const fakeRecord: ChatFileRecord = {
      fileId: "file_cancelled",
      fileRef: "file_cancelled.bin",
      kind: "file",
      origin: "browser_download",
      chatFilePath: "chat-files/media/file_cancelled.bin",
      sourceName: "file.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 4,
      createdAtMs: Date.now(),
      sourceContext: {},
      caption: null,
      captionStatus: "missing",
      captionModelRef: null,
      captionError: null
    };
    const fakeChatFileStore = {
      async importFileFromPath(): Promise<ChatFileRecord> {
        resolveImportStarted();
        await releasePromise;
        return fakeRecord;
      },
      async deleteFile(fileId: string): Promise<boolean> {
        deletedFileId = fileId;
        return true;
      }
    } as Pick<ChatFileStore, "importFileFromPath" | "deleteFile"> as ChatFileStore;
    const runtime = new DownloadRuntime(config, pino({ level: "silent" }), dir, fakeChatFileStore, { engine: createFakeEngine("data") as never });
    const initial = await runtime.start({
      sourceUrl: "https://example.com/file.bin",
      origin: "browser_download",
      foregroundWaitMs: 1
    });
    assert.equal(initial.status, "running");
    await importStarted;
    const cancelled = await runtime.cancel(initial.resource_id);
    assert.equal(cancelled?.status, "cancelled");
    releaseImport();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.read(initial.resource_id)?.status, "cancelled");
    assert.equal(deletedFileId, "file_cancelled");
    await runtime.close();
  });
});

test("download runtime fails fast when assets are disabled", async () => {
  await withTempDir(async (dir) => {
    const { runtime } = createRuntime(dir, {
      chatFiles: {
        enabled: false
      }
    });
    await assert.rejects(
      runtime.start({
        sourceUrl: "https://example.com/file.bin",
        origin: "browser_download"
      }),
      /assets are disabled/
    );
    await runtime.close();
  });
});

test("download runtime rejects URL credentials before creating a task", async () => {
  await withTempDir(async (dir) => {
    const { runtime } = createRuntime(dir);
    await assert.rejects(
      runtime.start({
        sourceUrl: "https://user:secret@example.com/file.bin",
        origin: "url_download"
      }),
      /must not contain credentials/
    );
    assert.deepEqual(runtime.list(), []);
    await runtime.close();
  });
});

async function waitForDownloadStatus(runtime: DownloadRuntime, resourceId: string, status: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (runtime.read(resourceId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`download ${resourceId} did not reach ${status}`);
}

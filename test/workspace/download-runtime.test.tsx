import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import { DownloadRuntime } from "../../src/services/workspace/downloadRuntime.ts";
import type { ChatFileRecord } from "../../src/services/workspace/types.ts";
import { setFetchImplementationForTests } from "../../src/services/proxy/index.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "llm-onebot-download-runtime-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createRuntime(rootDir: string, overrides: Parameters<typeof createTestAppConfig>[0] = {}) {
  const config = createTestAppConfig({
    localFiles: {
      enabled: true,
      root: rootDir,
      maxPatchFileBytes: 128 * 1024
    },
    chatFiles: {
      enabled: true,
      root: "chat-files",
      maxUploadBytes: 64,
      gcGracePeriodMs: 0
    },
    ...overrides
  });
  const logger = pino({ level: "silent" });
  const localFileService = new LocalFileService(config, rootDir);
  const chatFileStore = new ChatFileStore(config, logger, localFileService);
  const runtime = new DownloadRuntime(config, logger, rootDir, chatFileStore);
  return { runtime, chatFileStore };
}

test("download runtime imports a short download as a asset", async () => {
  await withTempDir(async (dir) => {
    const { runtime, chatFileStore } = createRuntime(dir);
    await chatFileStore.init();
    setFetchImplementationForTests(async (url) => {
      assert.equal(url, "https://example.com/file.txt");
      return new Response("hello world", {
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": "11",
          "Content-Disposition": "attachment; filename=\"file.txt\""
        }
      });
    });
    try {
      const result = await runtime.start({
        sourceUrl: "https://example.com/file.txt",
        origin: "browser_download",
        proxyConsumer: "browser",
        foregroundWaitMs: 1000
      });
      assert.equal(result.status, "completed");
      assert.equal(result.asset_ref?.endsWith(".txt"), true);
      assert.equal(result.source_name, "file.txt");
      assert.equal((await chatFileStore.listFiles()).length, 1);
    } finally {
      setFetchImplementationForTests(null);
    }
  });
});

test("download runtime rejects responses larger than asset limit", async () => {
  await withTempDir(async (dir) => {
    const { runtime, chatFileStore } = createRuntime(dir);
    await chatFileStore.init();
    setFetchImplementationForTests(async () => {
      return new Response(Buffer.alloc(65), {
        headers: { "Content-Type": "application/octet-stream" }
      });
    });
    try {
      const result = await runtime.start({
        sourceUrl: "https://example.com/large.bin",
        origin: "browser_download",
        proxyConsumer: "browser",
        foregroundWaitMs: 1000
      });
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /maxUploadBytes/);
      assert.deepEqual(await chatFileStore.listFiles(), []);
    } finally {
      setFetchImplementationForTests(null);
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
    const runtime = new DownloadRuntime(config, pino({ level: "silent" }), dir, fakeChatFileStore);
    setFetchImplementationForTests(async () => {
      return new Response("data", {
        headers: { "Content-Type": "application/octet-stream" }
      });
    });
    try {
      const initial = await runtime.start({
        sourceUrl: "https://example.com/file.bin",
        origin: "browser_download",
        proxyConsumer: "browser",
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
    } finally {
      setFetchImplementationForTests(null);
    }
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
  });
});

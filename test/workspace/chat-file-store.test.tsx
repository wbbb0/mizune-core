import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

test("chat file store serializes concurrent caption writes across files", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-"));
  try {
    const store = new ChatFileStore(
      createTestAppConfig({
        chatFiles: {
          enabled: true,
          root: "chat-files",
          maxUploadBytes: 1024 * 1024
        }
      }),
      createSilentLogger(),
      {
        rootDir,
        resolvePath(path: string) {
          return {
            sourcePath: path,
            absolutePath: join(rootDir, path)
          };
        }
      } as any
    );
    await store.init();
    const first = await store.importBuffer({
      buffer: Buffer.from("one"),
      sourceName: "one.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });
    const second = await store.importBuffer({
      buffer: Buffer.from("two"),
      sourceName: "two.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });

    await Promise.all([
      store.updateCaption(first.fileId, "第一个", { status: "ready", modelRef: "vision-a" }),
      store.updateCaption(second.fileId, "第二个", { status: "ready", modelRef: "vision-b" })
    ]);

    const captions = new Map((await store.listFiles()).map((file) => [file.fileId, file]));
    assert.equal(captions.get(first.fileId)?.caption, "第一个");
    assert.equal(captions.get(second.fileId)?.caption, "第二个");
    assert.equal(captions.get(first.fileId)?.captionModelRef, "vision-a");
    assert.equal(captions.get(second.fileId)?.captionModelRef, "vision-b");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("chat file store removes document cache when deleting files", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-doc-cache-"));
  try {
    const store = new ChatFileStore(
      createTestAppConfig({
        chatFiles: {
          enabled: true,
          root: "chat-files",
          maxUploadBytes: 1024 * 1024
        }
      }),
      createSilentLogger(),
      {
        rootDir,
        resolvePath(path: string) {
          return {
            sourcePath: path,
            absolutePath: join(rootDir, path)
          };
        }
      } as any
    );
    await store.init();
    const file = await store.importBuffer({
      buffer: Buffer.from("document"),
      sourceName: "document.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });
    const documentCacheDir = store.resolveDocumentCacheDirectory(file.fileId);
    await mkdir(documentCacheDir, { recursive: true });
    await writeFile(join(documentCacheDir, "manifest.json"), "{}\n", "utf8");

    assert.equal(await store.deleteFile(file.fileId), true);
    await assert.rejects(stat(documentCacheDir), /ENOENT/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("chat file store rejects absolute or escaping chatFiles.root", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-root-"));
  try {
    for (const configuredRoot of ["/tmp/chat-files", "C:\\chat-files", "../outside", "safe/..", "safe/../../outside"]) {
      assert.throws(() => new ChatFileStore(
        createTestAppConfig({
          chatFiles: {
            enabled: true,
            root: configuredRoot,
            maxUploadBytes: 1024 * 1024
          }
        }),
        createSilentLogger(),
        {
          rootDir,
          resolvePath(path: string) {
            return {
              sourcePath: path,
              absolutePath: join(rootDir, path)
            };
          }
        } as any
      ), /chatFiles\.root must be a relative path/);
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("chat file store document cache directory cannot collapse to store root", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-safe-doc-cache-"));
  try {
    const store = new ChatFileStore(
      createTestAppConfig({
        chatFiles: {
          enabled: true,
          root: "chat-files",
          maxUploadBytes: 1024 * 1024
        }
      }),
      createSilentLogger(),
      {
        rootDir,
        resolvePath(path: string) {
          return {
            sourcePath: path,
            absolutePath: join(rootDir, path)
          };
        }
      } as any
    );
    await store.init();
    const mediaPath = join(rootDir, "chat-files", "media", "evil.txt");
    await mkdir(join(rootDir, "chat-files", "media"), { recursive: true });
    await writeFile(mediaPath, "evil", "utf8");
    await writeFile(join(rootDir, "chat-files", "files.json"), `${JSON.stringify([{
      fileId: "..",
      fileRef: "evil.txt",
      kind: "file",
      origin: "user_upload",
      chatFilePath: "chat-files/media/evil.txt",
      sourceName: "evil.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      createdAtMs: 1,
      sourceContext: {},
      caption: null
    }], null, 2)}\n`, "utf8");

    const unsafeDirectory = join(rootDir, "chat-files", "documents", "..");
    assert.notEqual(store.resolveDocumentCacheDirectory(".."), unsafeDirectory);
    assert.equal(await store.deleteFile(".."), true);
    await stat(join(rootDir, "chat-files"));
    await stat(join(rootDir, "chat-files", "files.json"));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

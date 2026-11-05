import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { characterReferencedFileIds, characterRepository } from "../../src/character/repository.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

test("asset store serializes concurrent caption writes across files", async () => {
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

    const assetFiles = await readdir(join(rootDir, "assets"), { withFileTypes: true });
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "assets.sqlite"), true);
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "files.json"), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("asset store preserves null captionUpdatedAtMs in registry rows", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-registry-null-"));
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
      buffer: Buffer.from("one"),
      sourceName: "one.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });

    const listed = await store.listRows();
    assert.equal(listed.rows[0]?.captionUpdatedAtMs, null);

    const row = await store.getRow(file.fileId);
    assert.equal(row?.captionUpdatedAtMs, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("asset store removes document cache when deleting files", async () => {
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
            relativePath: path,
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

test("asset store cleans orphan document cache directories", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-orphan-doc-cache-"));
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
    const liveCacheDir = store.resolveDocumentCacheDirectory(file.fileId);
    const orphanCacheDir = join(rootDir, "chat-files", "documents", "id-orphan");
    await mkdir(liveCacheDir, { recursive: true });
    await mkdir(orphanCacheDir, { recursive: true });
    await writeFile(join(liveCacheDir, "manifest.json"), "{}\n", "utf8");
    await writeFile(join(orphanCacheDir, "manifest.json"), "{}\n", "utf8");

    assert.deepEqual(await store.cleanupOrphanDocumentCaches(), { removed: 1, kept: 1 });
    await stat(liveCacheDir);
    await assert.rejects(stat(orphanCacheDir), /ENOENT/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("asset store cleans media files missing database records", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-orphan-media-"));
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
    const mediaDir = join(rootDir, "chat-files", "media");
    const orphanPath = join(mediaDir, "orphan.bin");
    await writeFile(orphanPath, "orphan", "utf8");

    assert.deepEqual(await store.cleanupOrphanMediaFiles({ orphanTtlMs: 1, now: Date.now() + 10_000 }), { removed: 1, kept: 1 });
    await store.resolveAbsolutePath(file.fileId);
    await assert.rejects(stat(orphanPath), /ENOENT/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("asset store rejects absolute or escaping chatFiles.root", async () => {
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

test("asset store document cache directory cannot collapse to store root", async () => {
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
    await mkdir(join(rootDir, "chat-files", "media"), { recursive: true });
    const file = await store.importBuffer({
      buffer: Buffer.from("evil"),
      sourceName: "evil.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });

    const unsafeDirectory = join(rootDir, "chat-files", "documents", "..");
    assert.notEqual(store.resolveDocumentCacheDirectory(".."), unsafeDirectory);
    assert.equal(await store.deleteFile(file.fileId), true);
    await stat(join(rootDir, "chat-files"));
    await stat(join(rootDir, "assets", "assets.sqlite"));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("chat file store enforces maxUploadBytes for direct buffer imports", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-"));
  try {
    const store = new ChatFileStore(
      createTestAppConfig({
        chatFiles: {
          enabled: true,
          root: "chat-files",
          maxUploadBytes: 4
        }
      }),
      createSilentLogger(),
      {
        rootDir,
        resolvePath(path: string) {
          return {
            relativePath: path,
            absolutePath: join(rootDir, path)
          };
        }
      } as any
    );
    await store.init();

    await assert.rejects(
      store.importBuffer({
        buffer: Buffer.from("12345"),
        sourceName: "too-large.txt",
        mimeType: "text/plain",
        kind: "file",
        origin: "user_upload"
      }),
      /chat file import exceeds maxUploadBytes/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("chat file store keeps assets sqlite under dataDir even when localFiles.root is overridden", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-data-"));
  const localFilesRoot = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-local-root-"));
  try {
    const store = new ChatFileStore(
      createTestAppConfig({
        localFiles: {
          enabled: true,
          root: localFilesRoot
        },
        chatFiles: {
          enabled: true,
          root: "chat-files",
          maxUploadBytes: 1024 * 1024
        }
      }),
      createSilentLogger(),
      {
        rootDir: localFilesRoot,
        resolvePath(path: string) {
          return {
            relativePath: path,
            absolutePath: join(localFilesRoot, path)
          };
        }
      } as any,
      dataDir
    );
    await store.init();
    await store.importBuffer({
      buffer: Buffer.from("hello"),
      sourceName: "hello.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });

    const dataDirAssets = await readdir(join(dataDir, "assets"), { withFileTypes: true });
    assert.equal(dataDirAssets.some((entry) => entry.isFile() && entry.name === "assets.sqlite"), true);

    const localRootAssets = await readdir(localFilesRoot, { withFileTypes: true });
    assert.equal(localRootAssets.some((entry) => entry.isDirectory() && entry.name === "assets"), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(localFilesRoot, { recursive: true, force: true });
  }
});

test("chat file store refuses to delete files retained by lease or injected persistent references", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-retention-"));
  try {
    let failReferenceRead = false;
    const config = createTestAppConfig({
      dataDir: rootDir,
      chatFiles: {
        enabled: true,
        root: "chat-files",
        maxUploadBytes: 1024 * 1024
      }
    });
    const store = new ChatFileStore(
      config,
      createSilentLogger(),
      {
        rootDir,
        resolvePath(path: string) {
          return {
            sourcePath: path,
            absolutePath: join(rootDir, path)
          };
        }
      } as any,
      rootDir,
      undefined,
      () => {
        if (failReferenceRead) throw new Error("引用读取失败");
        return characterReferencedFileIds(rootDir);
      }
    );
    await store.init();
    const leasedFile = await store.importBuffer({
      buffer: Buffer.from("leased"),
      sourceName: "leased.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });
    const refFile = await store.importBuffer({
      buffer: Buffer.from("ref"),
      sourceName: "ref.txt",
      mimeType: "text/plain",
      kind: "file",
      origin: "user_upload"
    });

    await store.withRetainedFiles([leasedFile.fileId], async () => {
      assert.deepEqual([...store.listRetainedFileIds()], [leasedFile.fileId]);
      await assert.rejects(store.deleteFile(leasedFile.fileId), /正在使用/);
    });
    assert.equal(store.listRetainedFileIds().size, 0);
    assert.equal(await store.deleteFile(leasedFile.fileId), true);

    const charStore = characterRepository(rootDir);
    charStore.begin("s", "persona", "setup", "stateful_rp");
    charStore.confirm("s", "stateful_rp");
    const socialDraft = charStore.begin("s", "social", "setup", "stateful_rp");
    charStore.edit(
      "s",
      "stateful_rp",
      "social.referenceImages",
      "upsert",
      { id: "ref-1", fileId: refFile.fileId, label: "参考图", subject: null, description: "描述" },
      "ref-1",
      socialDraft.id
    );
    await assert.rejects(store.deleteFile(refFile.fileId), /长期资料引用/);
    charStore.confirm("s", "stateful_rp");
    await assert.rejects(store.deleteFile(refFile.fileId), /长期资料引用/);

    // 移除角色引用后允许正常删除
    const nextDraft = charStore.begin("s", "social", "config", "stateful_rp");
    charStore.edit("s", "stateful_rp", "social.referenceImages", "remove", undefined, "ref-1", nextDraft.id);
    charStore.confirm("s", "stateful_rp");
    failReferenceRead = true;
    await assert.rejects(store.deleteFile(refFile.fileId), /引用读取失败/);
    assert.ok(await store.getFile(refFile.fileId));
    assert.equal(await store.isFileAvailable(refFile.fileId), true);
    failReferenceRead = false;
    assert.equal(await store.deleteFile(refFile.fileId), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("asset retention waits for an in-flight deletion check and prevents deletion before validation starts", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-onebot-chat-file-store-retention-race-"));
  try {
    let entered!: () => void;
    let release!: () => void;
    const deletionStarted = new Promise<void>(resolve => { entered = resolve; });
    const allowReferenceRead = new Promise<void>(resolve => { release = resolve; });
    const store = new ChatFileStore(
      createTestAppConfig({ dataDir: rootDir }),
      createSilentLogger(),
      { rootDir, resolvePath: (path: string) => ({ absolutePath: join(rootDir, path) }) } as any,
      rootDir,
      undefined,
      async () => {
        entered();
        await allowReferenceRead;
        return [];
      }
    );
    await store.init();
    const file = await store.importBuffer({ buffer: Buffer.from("race"), sourceName: "race.txt", kind: "file", origin: "user_upload" });
    const deletion = assert.rejects(store.deleteFile(file.fileId), /正在使用/);
    await deletionStarted;
    let validationStarted = false;
    const retained = store.withRetainedFiles([file.fileId], async () => {
      validationStarted = true;
      assert.ok(await store.getFile(file.fileId));
      assert.equal(await store.isFileAvailable(file.fileId), true);
      await store.withRetainedFiles([file.fileId], () => {
        assert.deepEqual([...store.listRetainedFileIds()], [file.fileId]);
      });
      assert.deepEqual([...store.listRetainedFileIds()], [file.fileId]);
    });
    await Promise.resolve();
    assert.equal(validationStarted, false);
    release();
    await deletion;
    await retained;
    assert.equal(validationStarted, true);
    assert.equal(store.listRetainedFileIds().size, 0);
    await assert.rejects(store.withRetainedFiles([file.fileId], () => { throw new Error("validation failed"); }), /validation failed/);
    assert.equal(store.listRetainedFileIds().size, 0);
    assert.equal(await store.deleteFile(file.fileId), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

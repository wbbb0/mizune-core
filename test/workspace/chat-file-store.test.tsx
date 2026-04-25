import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

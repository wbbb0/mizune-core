import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { s } from "../../src/data/schema/index.ts";
import { FileSchemaStore } from "../../src/data/fileSchemaStore.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "llm-bot-file-store-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const counterSchema = s.object({
  value: s.number().int()
}).strict();

  test("atomic writes tolerate concurrent writes to the same file", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSchemaStore({
        filePath: join(dir, "store.json"),
        schema: counterSchema,
        logger: pino({ level: "silent" }),
        loadErrorEvent: "file_schema_store_load_failed",
        atomicWrite: true
      });

      await Promise.all(
        Array.from({ length: 25 }, (_, index) => store.write({ value: index }))
      );

      const written = JSON.parse(await readFile(join(dir, "store.json"), "utf8"));
      assert.equal(typeof written.value, "number");
      assert.ok(written.value >= 0);
      assert.ok(written.value < 25);
    });
  });

  test("readOrDefault regenerates a corrupted file", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json");
      const store = new FileSchemaStore({
        filePath,
        schema: counterSchema,
        logger: pino({ level: "silent" }),
        loadErrorEvent: "file_schema_store_load_failed",
        atomicWrite: true
      });

      await writeFile(filePath, "{not valid json", "utf8");

      const recovered = await store.readOrDefault({ value: 7 });
      const rewritten = JSON.parse(await readFile(filePath, "utf8"));

      assert.deepEqual(recovered, { value: 7 });
      assert.deepEqual(rewritten, { value: 7 });
    });
  });

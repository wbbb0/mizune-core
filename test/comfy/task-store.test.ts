import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ComfyTaskStore } from "../../src/comfy/taskStore.ts";

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("comfy task store persists tasks in assets sqlite without legacy json output", async () => {
  await withDataDir("llm-bot-comfy-task-store", async (dataDir) => {
    const store = new ComfyTaskStore(dataDir, pino({ level: "silent" }));
    await store.init();

    const created = await store.create({
      sessionId: "private:u1",
      userId: "u1",
      templateId: "t1",
      workflowFile: "wf.json",
      workflowSnapshot: { nodes: [] },
      positivePrompt: "hello",
      aspectRatio: "1:1",
      resolvedWidth: 1024,
      resolvedHeight: 1024,
      comfyPromptId: "prompt-1",
      status: "queued",
      resultFileIds: [],
      resultFiles: [],
      autoIterationIndex: 0,
      maxAutoIterations: 1,
      lastError: null,
      startedAtMs: null,
      finishedAtMs: null
    });

    assert.equal((await store.getById(created.id))?.templateId, "t1");
    const db = (store as any).assetsDatabase.getDb();
    const taskColumns = (db.prepare("PRAGMA table_info(comfy_tasks)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(taskColumns.includes("result_file_ids_json"), false);
    assert.equal(taskColumns.includes("result_files_json"), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM comfy_task_result_files").get() as { count: number }).count, 0);
    const assetFiles = await readdir(join(dataDir, "assets"), { withFileTypes: true });
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "assets.sqlite"), true);
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "tasks.json"), false);
  });
});

test("comfy task store updates active task state in sqlite", async () => {
  await withDataDir("llm-bot-comfy-task-store-update", async (dataDir) => {
    const store = new ComfyTaskStore(dataDir, pino({ level: "silent" }));
    await store.init();

    const created = await store.create({
      sessionId: "private:u1",
      userId: "u1",
      templateId: "t1",
      workflowFile: "wf.json",
      workflowSnapshot: { nodes: [] },
      positivePrompt: "hello",
      aspectRatio: "1:1",
      resolvedWidth: 1024,
      resolvedHeight: 1024,
      comfyPromptId: "prompt-1",
      status: "queued",
      resultFileIds: [],
      resultFiles: [],
      autoIterationIndex: 0,
      maxAutoIterations: 1,
      lastError: null,
      startedAtMs: null,
      finishedAtMs: null
    });

    const updated = await store.updateById(created.id, (task) => ({
      ...task,
      status: "running",
      startedAtMs: 123,
      resultFileIds: ["file-1"],
      resultFiles: [{
        filename: "out.png",
        subfolder: "",
        type: "output"
      }]
    }));

    assert.equal(updated?.status, "running");
    assert.equal((await store.listActive()).some((task) => task.id === created.id), true);
    assert.equal((await store.getById(created.id))?.startedAtMs, 123);
    assert.deepEqual((await store.getById(created.id))?.resultFileIds, ["file-1"]);
    assert.deepEqual((await store.getById(created.id))?.resultFiles, [{
      filename: "out.png",
      subfolder: "",
      type: "output"
    }]);
    assert.deepEqual((await store.listResultRows()).rows, [{
      taskId: created.id,
      resultIndex: 0,
      fileId: "file-1",
      filename: "out.png",
      subfolder: "",
      type: "output"
    }]);
  });
});

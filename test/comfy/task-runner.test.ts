import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ComfyTaskRunner } from "../../src/comfy/taskRunner.ts";
import type { ComfyTaskRecord } from "../../src/comfy/taskSchema.ts";
import type { ComfyTaskStore } from "../../src/comfy/taskStore.ts";
import type { ComfyClient } from "../../src/comfy/comfyClient.ts";
import type { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("Comfy completion survives failed notification and retries without regenerating assets", async () => {
  let task = { id: "task", comfyPromptId: "prompt", status: "queued", resultFileIds: [] } as unknown as ComfyTaskRecord;
  let notifications = 0;
  let historyReads = 0;
  let imports = 0;
  let receivedIds: string[] = [];
  const runner = new ComfyTaskRunner({
    config: createTestAppConfig({ comfy: { enabled: true } }), logger: pino({ level: "silent" }),
    comfyTaskStore: {
      async listActive() { return task.status === "notified" ? [] : [task]; },
      async update(next: ComfyTaskRecord) { task = next; return next; }
    } as unknown as ComfyTaskStore,
    comfyClient: {
      async getQueue() { return { runningPromptIds: new Set(), pendingPromptIds: new Set() }; },
      async getHistory() { historyReads++; return { completed: true, status: "success", images: [{ filename: "first.png" }, { filename: "second.png" }] }; },
      async downloadView() { return Buffer.from("synthetic"); }
    } as unknown as ComfyClient,
    chatFileStore: {
      async importBuffer() { const fileId = String(++imports); return { fileId, chatFilePath: fileId }; },
      async getMany() { return [{ fileId: "2", chatFilePath: "2" }, { fileId: "1", chatFilePath: "1" }]; }
    } as unknown as ChatFileStore,
    async notifyCompletedTask(_task, files) { receivedIds = files.map((file) => file.fileId); if (++notifications === 1) throw new Error("temporary dispatch failure"); },
    async notifyFailedTask() {}
  });
  await runner.notifyNewTask("task");
  assert.equal(task.status, "succeeded");
  await runner.notifyNewTask("task");
  assert.equal(task.status, "notified");
  await runner.notifyNewTask("task");
  assert.equal(notifications, 2);
  assert.equal(historyReads, 1);
  assert.equal(imports, 2);
  assert.deepEqual(receivedIds, ["1", "2"]);
});

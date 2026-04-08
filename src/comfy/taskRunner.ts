import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { ComfyClient } from "./comfyClient.ts";
import type { ComfyTaskStore } from "./taskStore.ts";
import type { ComfyTaskRecord } from "./taskSchema.ts";

export class ComfyTaskRunner {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly input: {
      config: AppConfig;
      logger: Logger;
      comfyClient: ComfyClient;
      comfyTaskStore: ComfyTaskStore;
      mediaWorkspace: MediaWorkspace;
      notifyCompletedTask: (task: ComfyTaskRecord, assets: Array<{ fileId: string; path: string }>) => Promise<void>;
      notifyFailedTask: (task: ComfyTaskRecord) => Promise<void>;
    }
  ) {}

  async start(): Promise<void> {
    if (!this.input.config.comfy.enabled) {
      return;
    }
    await this.pollOnce();
    if (this.timer != null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.input.config.comfy.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async notifyNewTask(_taskId: string): Promise<void> {
    await this.pollOnce();
  }

  async reloadConfig(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || !this.input.config.comfy.enabled) {
      return;
    }
    this.polling = true;
    try {
      const tasks = await this.input.comfyTaskStore.listActive();
      if (tasks.length === 0) {
        return;
      }
      const queue = await this.input.comfyClient.getQueue();
      for (const task of tasks) {
        await this.handleTask(task, queue);
      }
    } catch (error: unknown) {
      this.input.logger.warn({ error }, "comfy_task_poll_failed");
    } finally {
      this.polling = false;
    }
  }

  private async handleTask(
    task: ComfyTaskRecord,
    queue: {
      runningPromptIds: Set<string>;
      pendingPromptIds: Set<string>;
    }
  ): Promise<void> {
    if (queue.runningPromptIds.has(task.comfyPromptId)) {
      if (task.status !== "running") {
        await this.input.comfyTaskStore.update({
          ...task,
          status: "running",
          startedAtMs: task.startedAtMs ?? Date.now()
        });
      }
      return;
    }

    if (queue.pendingPromptIds.has(task.comfyPromptId)) {
      if (task.status !== "queued") {
        await this.input.comfyTaskStore.update({
          ...task,
          status: "queued"
        });
      }
      return;
    }

    const history = await this.input.comfyClient.getHistory(task.comfyPromptId);
    if (!history) {
      return;
    }

    if (!history.completed || history.status !== "success") {
      const failed = {
        ...task,
        status: "failed" as const,
        lastError: history.status || "Comfy task failed",
        finishedAtMs: Date.now()
      };
      await this.input.comfyTaskStore.update(failed);
      await this.input.notifyFailedTask(failed);
      return;
    }

    const assets: Array<{ fileId: string; path: string }> = [];
    for (const file of history.images) {
      const bytes = await this.input.comfyClient.downloadView(file);
      const imported = await this.input.mediaWorkspace.importBuffer({
        buffer: bytes,
        sourceName: file.filename,
        mimeType: "image/png",
        kind: "image",
        origin: "comfy_generated",
        sourceContext: {
          taskId: task.id,
          templateId: task.templateId,
          comfyPromptId: task.comfyPromptId,
          positivePrompt: task.positivePrompt,
          aspectRatio: task.aspectRatio,
          width: task.resolvedWidth,
          height: task.resolvedHeight,
          filename: file.filename,
          subfolder: file.subfolder,
          type: file.type
        }
      });
      assets.push({
        fileId: imported.fileId,
        path: imported.workspacePath
      });
    }

    const completed = {
      ...task,
      status: "notified" as const,
      resultAssetIds: assets.map((item) => item.fileId),
      resultFiles: history.images,
      finishedAtMs: Date.now()
    };
    await this.input.comfyTaskStore.update(completed);
    await this.input.notifyCompletedTask(completed, assets);
  }
}

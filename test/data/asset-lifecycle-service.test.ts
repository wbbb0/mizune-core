import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { AssetLifecycleService } from "../../src/data/assets/assetLifecycleService.ts";
import { AssetLifecycleStore } from "../../src/data/assets/assetLifecycleStore.ts";
import type { StoredAudioFile } from "../../src/audio/audioStore.ts";
import type { ComfyTaskRecord } from "../../src/comfy/taskSchema.ts";
import type { ChatFileRecord } from "../../src/services/workspace/types.ts";

test("asset lifecycle deletes only unreferenced expired assets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-lifecycle-"));
  try {
    const chatFiles: ChatFileRecord[] = [
      chatFile("keep-chat", 0, 10),
      chatFile("keep-comfy-result", 0, 10, { fileRef: "keep-comfy-result-ref", origin: "comfy_generated" }),
      chatFile("keep-tool-result", 0, 10, { fileRef: "keep-tool-result-ref", origin: "browser_screenshot" }),
      chatFile("keep-user-upload", 0, 10, { origin: "user_upload" }),
      chatFile("delete-chat", 0, 20)
    ];
    const audioFiles: StoredAudioFile[] = [
      audioFile("keep-audio", 0),
      audioFile("delete-audio", 0)
    ];
    const comfyTasks: ComfyTaskRecord[] = [
      comfyTask("keep-task", "session-1", 0, ["keep-comfy-result"]),
      comfyTask("delete-task", "missing-session", 0)
    ];
    const deletedChatFileIds: string[] = [];
    const deletedAudioIds: string[] = [];
    const deletedComfyTaskIds: string[] = [];
    const service = new AssetLifecycleService(
      new AssetLifecycleStore(dataDir, pino({ level: "silent" })),
      {
        chatFileStore: {
          async listFiles() {
            return chatFiles;
          },
          async deleteFile(fileId) {
            deletedChatFileIds.push(fileId);
            removeBy(chatFiles, (file) => file.fileId === fileId);
            return true;
          },
          async cleanupOrphanDocumentCaches() {
            return { removed: 0, kept: 0 };
          },
          async cleanupOrphanMediaFiles() {
            return { removed: 0, kept: 0 };
          }
        },
        audioStore: {
          async listRows() {
            return { rows: audioFiles, total: audioFiles.length, offset: 0, limit: 500 };
          },
          async deleteAudio(audioId) {
            deletedAudioIds.push(audioId);
            removeBy(audioFiles, (audio) => audio.id === audioId);
            return true;
          }
        },
        comfyTaskStore: {
          async listRows() {
            return { rows: comfyTasks, total: comfyTasks.length, offset: 0, limit: 500 };
          },
          async deleteById(taskId) {
            deletedComfyTaskIds.push(taskId);
            removeBy(comfyTasks, (task) => task.id === taskId);
            return true;
          }
        }
      },
      pino({ level: "silent" }),
      {
        enabled: true,
        ttlMs: 100,
        orphanFileTtlMs: 100,
        maxTotalBytes: null,
        targetTotalBytes: null
      }
    );
    await service.init();

    const result = await service.sweep({
      now: 200,
      activeSessions: [{
        id: "session-1",
        pendingMessages: [{
          imageIds: ["keep-chat"],
          emojiIds: [],
          audioIds: ["keep-audio"],
          attachments: [],
          contentParts: []
        }],
        internalTranscript: [{
            id: "tool-result-1",
            kind: "tool_result",
            llmVisible: true,
            timestampMs: 1,
            toolCallId: "call_1",
            toolName: "capture_screenshot",
            content: JSON.stringify({
              file_id: "keep-tool-result",
              asset_handle: {
                asset_id: "keep-tool-result",
                asset_ref: "keep-tool-result-ref"
              }
            }),
            observation: {
              contentHash: "hash",
              inputTokensEstimate: 1,
              summary: "screenshot",
              retention: "handle",
              replayContent: JSON.stringify({
                fileRef: "keep-tool-result-ref",
                assetHandle: {
                  assetId: "keep-tool-result",
                  assetRef: "keep-tool-result-ref"
                }
              }),
              resource: { kind: "asset", id: "keep-tool-result-ref" },
              replaySafe: true,
              refetchable: true,
              pinned: false
            }
          } as any]
      } as any],
      persistedSessions: []
    });

    assert.deepEqual(result.deletedChatFileIds, ["delete-chat"]);
    assert.deepEqual(result.deletedAudioIds, ["delete-audio"]);
    assert.deepEqual(result.deletedComfyTaskIds, ["delete-task"]);
    assert.deepEqual(deletedChatFileIds, ["delete-chat"]);
    assert.deepEqual(deletedAudioIds, ["delete-audio"]);
    assert.deepEqual(deletedComfyTaskIds, ["delete-task"]);
    assert.deepEqual(chatFiles.map((file) => file.fileId), ["keep-chat", "keep-comfy-result", "keep-tool-result", "keep-user-upload"]);
    assert.deepEqual(audioFiles.map((audio) => audio.id), ["keep-audio"]);
    assert.deepEqual(comfyTasks.map((task) => task.id), ["keep-task"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("asset lifecycle removes session refs before sweeping deleted sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-lifecycle-session-delete-"));
  try {
    const chatFiles: ChatFileRecord[] = [chatFile("session-file", 0, 10)];
    const service = new AssetLifecycleService(
      new AssetLifecycleStore(dataDir, pino({ level: "silent" })),
      {
        chatFileStore: {
          async listFiles() {
            return chatFiles;
          },
          async deleteFile(fileId) {
            removeBy(chatFiles, (file) => file.fileId === fileId);
            return true;
          },
          async cleanupOrphanDocumentCaches() {
            return { removed: 0, kept: 0 };
          },
          async cleanupOrphanMediaFiles() {
            return { removed: 0, kept: 0 };
          }
        },
        audioStore: {
          async listRows() {
            return { rows: [], total: 0, offset: 0, limit: 500 };
          },
          async deleteAudio() {
            return false;
          }
        },
        comfyTaskStore: {
          async listRows() {
            return { rows: [], total: 0, offset: 0, limit: 500 };
          },
          async deleteById() {
            return false;
          }
        }
      },
      pino({ level: "silent" }),
      {
        enabled: true,
        ttlMs: 100,
        orphanFileTtlMs: 100,
        maxTotalBytes: null,
        targetTotalBytes: null
      }
    );
    await service.init();
    await service.sweep({
      now: 50,
      activeSessions: [{
        id: "session-1",
        pendingMessages: [{ imageIds: ["session-file"], emojiIds: [], audioIds: [], attachments: [], contentParts: [] }],
        internalTranscript: []
      } as any],
      persistedSessions: []
    });
    assert.equal(chatFiles.length, 1);

    const result = await service.onSessionDeleted({
      sessionId: "session-1",
      activeSessions: [],
      persistedSessions: []
    });
    assert.deepEqual(result.deletedChatFileIds, ["session-file"]);
    assert.equal(chatFiles.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("asset lifecycle self-heals refs whose sessions disappeared", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-onebot-asset-lifecycle-stale-session-"));
  try {
    const store = new AssetLifecycleStore(dataDir, pino({ level: "silent" }));
    const chatFiles: ChatFileRecord[] = [chatFile("stale-session-file", 0, 10)];
    const service = new AssetLifecycleService(
      store,
      {
        chatFileStore: {
          async listFiles() {
            return chatFiles;
          },
          async deleteFile(fileId) {
            removeBy(chatFiles, (file) => file.fileId === fileId);
            return true;
          },
          async cleanupOrphanDocumentCaches() {
            return { removed: 0, kept: 0 };
          },
          async cleanupOrphanMediaFiles() {
            return { removed: 0, kept: 0 };
          }
        },
        audioStore: {
          async listRows() {
            return { rows: [], total: 0, offset: 0, limit: 500 };
          },
          async deleteAudio() {
            return false;
          }
        },
        comfyTaskStore: {
          async listRows() {
            return { rows: [], total: 0, offset: 0, limit: 500 };
          },
          async deleteById() {
            return false;
          }
        }
      },
      pino({ level: "silent" }),
      {
        enabled: true,
        ttlMs: 100,
        orphanFileTtlMs: 100,
        maxTotalBytes: null,
        targetTotalBytes: null
      }
    );
    await service.init();
    await store.replaceSessionRefs("missing-session", [{
      assetKind: "chat_file",
      assetId: "stale-session-file",
      sessionId: "missing-session",
      refKind: "message",
      createdAtMs: 0,
      lastSeenAtMs: 0,
      expiresAtMs: null
    }]);

    const result = await service.sweep({
      now: 200,
      activeSessions: [],
      persistedSessions: []
    });

    assert.deepEqual(result.deletedChatFileIds, ["stale-session-file"]);
    assert.equal(chatFiles.length, 0);
    assert.deepEqual(await store.listRefs(), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function chatFile(
  fileId: string,
  createdAtMs: number,
  sizeBytes: number,
  overrides: Partial<Pick<ChatFileRecord, "fileRef" | "origin">> = {}
): ChatFileRecord {
  return {
    fileId,
    fileRef: overrides.fileRef ?? `${fileId}.bin`,
    kind: "file",
    origin: overrides.origin ?? "chat_message",
    chatFilePath: `chat-files/media/${fileId}.bin`,
    sourceName: `${fileId}.bin`,
    mimeType: "application/octet-stream",
    sizeBytes,
    createdAtMs,
    sourceContext: {},
    caption: null,
    captionStatus: "missing",
    captionUpdatedAtMs: null,
    captionModelRef: null,
    captionError: null
  };
}

function audioFile(id: string, createdAt: number): StoredAudioFile {
  return {
    id,
    source: `${id}.wav`,
    createdAt,
    transcription: null,
    transcriptionStatus: "missing",
    transcriptionUpdatedAt: null,
    transcriptionModelRef: null,
    transcriptionError: null
  };
}

function comfyTask(id: string, sessionId: string, updatedAtMs: number, resultFileIds: string[] = []): ComfyTaskRecord {
  return {
    id,
    sessionId,
    userId: "user-1",
    templateId: "template-1",
    workflowFile: "workflow.json",
    workflowSnapshot: {},
    positivePrompt: "prompt",
    aspectRatio: "1:1",
    resolvedWidth: 512,
    resolvedHeight: 512,
    comfyPromptId: `prompt-${id}`,
    status: "succeeded",
    resultFileIds,
    resultFiles: [],
    autoIterationIndex: 0,
    maxAutoIterations: 1,
    lastError: null,
    createdAtMs: updatedAtMs,
    updatedAtMs,
    startedAtMs: null,
    finishedAtMs: null
  };
}

function removeBy<T>(items: T[], predicate: (item: T) => boolean): void {
  const index = items.findIndex(predicate);
  if (index >= 0) {
    items.splice(index, 1);
  }
}

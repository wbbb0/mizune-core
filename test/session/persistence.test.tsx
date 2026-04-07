import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import type { PersistedSessionState } from "../../src/conversation/session/sessionManager.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await runCase("session persistence round-trips current session shape", async () => {
    await withDataDir("llm-bot-session-persist-current-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const session: PersistedSessionState = {
        id: "private:owner",
        type: "private",
        source: "onebot",
        participantUserId: "owner",
        participantLabel: "Owner",
        lastInboundDelivery: "web",
        pendingMessages: [
          {
            userId: "owner",
            senderName: "Owner",
            chatType: "private",
            text: "hello",
            images: [],
            audioSources: [],
            audioIds: [],
            emojiSources: [],
            imageIds: [],
            emojiIds: [],
            attachments: [],
            forwardIds: [],
            replyMessageId: null,
            mentionUserIds: [],
            mentionedAll: false,
            isAtMentioned: false,
            receivedAt: 1
          }
        ],
        historySummary: null,
        internalTranscript: [
          {
            kind: "user_message",
            role: "user",
            llmVisible: true,
            chatType: "private",
            userId: "owner",
            senderName: "Owner",
            text: "hello",
            imageIds: [],
            emojiIds: [],
            attachments: [],
            audioCount: 0,
            forwardIds: [],
            replyMessageId: null,
            mentionUserIds: [],
            mentionedAll: false,
            mentionedSelf: false,
            timestampMs: 1
          },
          {
            kind: "outbound_media_message",
            llmVisible: false,
            role: "assistant",
            delivery: "web",
            mediaKind: "image",
            assetId: "asset_img_1",
            filename: "hello.png",
            messageId: null,
            toolName: "send_workspace_media_to_chat",
            captionText: null,
            timestampMs: 2
          },
          {
            kind: "fallback_event",
            llmVisible: false,
            timestampMs: 3,
            fallbackType: "model_candidate_switch",
            title: "模型切换 fallback",
            summary: "模型候选 main 请求失败，已切换到 backup",
            details: "Error: 503 Service Unavailable",
            fromModelRef: "main",
            toModelRef: "backup",
            fromProvider: "provider_a",
            toProvider: "provider_b"
          },
          {
            kind: "internal_trigger_event",
            llmVisible: false,
            timestampMs: 4,
            triggerKind: "scheduled_instruction",
            stage: "started",
            title: "内部触发器 · 开始执行",
            summary: "开始执行定时任务「daily」，目标 私聊 owner",
            jobName: "daily",
            targetType: "private",
            targetUserId: "owner",
            details: "提醒我喝水"
          }
        ],
        debugMarkers: [],
        recentToolEvents: [
          {
            toolName: "open_page",
            argsSummary: "{\"url\":\"https://example.com\"}",
            outcome: "success",
            resultSummary: "opened example page",
            timestampMs: 2
          }
        ],
        lastLlmUsage: {
          inputTokens: 12,
          outputTokens: 34,
          totalTokens: 46,
          cachedTokens: 5,
          reasoningTokens: null,
          requestCount: 1,
          providerReported: true,
          modelRef: "default",
          model: "test-model",
          capturedAt: 2
        },
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      };

      await persistence.save(session);
      assert.deepEqual(await persistence.loadAll(), [session]);
    });
  });

  await runCase("session persistence keeps google replay metadata for assistant tool calls", async () => {
    await withDataDir("llm-bot-session-persist-google-tool-metadata-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const session: PersistedSessionState = {
        id: "private:google-tool",
        type: "private",
        source: "onebot",
        participantUserId: "google-tool",
        participantLabel: "google-tool",
        lastInboundDelivery: "onebot",
        pendingMessages: [],
        historySummary: null,
        internalTranscript: [{
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 1,
          content: "",
          toolCalls: [{
            id: "tool-call-1",
            type: "function",
            function: {
              name: "open_page",
              arguments: "{\"url\":\"https://example.com\"}"
            },
            providerMetadata: {
              google: {
                thoughtSignature: "sig-1"
              }
            }
          }],
          providerMetadata: {
            googleParts: [{
              thoughtSignature: "sig-1",
              functionCall: {
                id: "tool-call-1",
                name: "open_page",
                args: {
                  url: "https://example.com"
                }
              }
            }]
          }
        }],
        debugMarkers: [],
        recentToolEvents: [],
        lastLlmUsage: null,
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      };

      await persistence.save(session);
      assert.deepEqual(await persistence.loadAll(), [session]);
    });
  });

  await runCase("session persistence skips legacy session files missing current fields", async () => {
    await withDataDir("llm-bot-session-persist-legacy-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const filePath = join(dataDir, "sessions", `${encodeURIComponent("private:legacy")}.json`);
      await writeFile(filePath, JSON.stringify({
        id: "private:legacy",
        type: "private",
        pendingMessages: [
          {
            userId: "owner",
            senderName: "Owner",
            chatType: "private",
            text: "legacy",
            images: [],
            receivedAt: 1
          }
        ],
        historySummary: null,
        lastLlmUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          requestCount: 1,
          providerReported: true,
          modelRef: "legacy",
          model: "legacy-model",
          capturedAt: 2
        },
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      }, null, 2));

      assert.deepEqual(await persistence.loadAll(), []);
    });
  });

  await runCase("session persistence loads usage snapshots without cached tokens as null", async () => {
    await withDataDir("llm-bot-session-persist-cached-tokens-compat-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const filePath = join(dataDir, "sessions", `${encodeURIComponent("private:compat")}.json`);
      await writeFile(filePath, JSON.stringify({
        id: "private:compat",
        type: "private",
        pendingMessages: [],
        historySummary: null,
        internalTranscript: [],
        debugMarkers: [],
        recentToolEvents: [],
        lastLlmUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          requestCount: 1,
          providerReported: true,
          modelRef: "compat",
          model: "compat-model",
          capturedAt: 2
        },
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      }, null, 2));

      assert.deepEqual(await persistence.loadAll(), [{
        id: "private:compat",
        type: "private",
        source: "onebot",
        lastInboundDelivery: "onebot",
        pendingMessages: [],
        historySummary: null,
        internalTranscript: [],
        debugMarkers: [],
        recentToolEvents: [],
        lastLlmUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          cachedTokens: null,
          reasoningTokens: null,
          requestCount: 1,
          providerReported: true,
          modelRef: "compat",
          model: "compat-model",
          capturedAt: 2
        },
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      }]);
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

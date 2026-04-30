import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createTempDir } from "../helpers/temp-paths.ts";
import { ContentSafetyService } from "../../src/contentSafety/contentSafetyService.ts";
import { contentSafetyHashText } from "../../src/contentSafety/contentSafetyHash.ts";
import { ContentSafetyStore } from "../../src/contentSafety/contentSafetyStore.ts";
import type { EnrichedIncomingMessage } from "../../src/app/messaging/messageHandlerTypes.ts";
import type { ChatFileRecord } from "../../src/services/workspace/types.ts";

function createConfig() {
  return createTestAppConfig({
    contentSafety: {
      enabled: true,
      providers: {
        localKeyword: {
          type: "keyword",
          enabled: true,
          blockedTextKeywords: ["违规词"],
          blockedMediaNameKeywords: ["blocked"]
        }
      },
      profiles: {
        preLlm: {
          text: {
            provider: "localKeyword",
            action: "replace_in_projection"
          },
          image: {
            provider: "localKeyword",
            action: "hide_from_projection_and_mark"
          },
          emoji: {
            provider: "localKeyword",
            action: "hide_from_projection_and_mark"
          },
          audio: {
            provider: "localKeyword",
            action: "mark_unavailable"
          }
        }
      },
      routes: {
        inbound: {
          onebot: "preLlm",
          web: "preLlm"
        }
      }
    }
  });
}

function createMessage(overrides: Partial<EnrichedIncomingMessage> = {}): EnrichedIncomingMessage {
  return {
    channelId: "qqbot",
    externalUserId: "10001",
    chatType: "private",
    userId: "user_internal",
    senderName: "Tester",
    text: "hello",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false,
    receivedAt: 123,
    ...overrides
  } as EnrichedIncomingMessage;
}

function createChatFile(fileId: string, sourceName: string): ChatFileRecord {
  return {
    fileId,
    fileRef: `${fileId}.png`,
    kind: "image",
    origin: "chat_message",
    chatFilePath: `chat-files/media/${fileId}.png`,
    sourceName,
    mimeType: "image/png",
    sizeBytes: 4,
    createdAtMs: 123,
    sourceContext: {},
    caption: null,
    captionStatus: "missing",
    captionModelRef: null,
    captionError: null
  };
}

async function createHarness(files: ChatFileRecord[] = []) {
  const dataDir = createTempDir("content-safety-service");
  await mkdir(dataDir, { recursive: true });
  const store = new ContentSafetyStore(dataDir, pino({ level: "silent" }));
  await store.init();
  const fileMap = new Map(files.map((file) => [file.fileId, file]));
  const service = new ContentSafetyService(
    createConfig(),
    pino({ level: "silent" }),
    store,
    {
      async getFile(fileId: string) {
        return fileMap.get(fileId) ?? null;
      }
    }
  );
  return {
    dataDir,
    store,
    service,
    cleanup: async () => rm(dataDir, { recursive: true, force: true })
  };
}

test("blocked text is projected as a marker while raw text is kept in audit", async () => {
  const harness = await createHarness();
  try {
    const message = createMessage({ text: "这是一段违规词测试" });
    const result = await harness.service.moderateIncomingMessage({
      message,
      sessionId: "qqbot:p:test",
      delivery: "onebot"
    });

    assert.equal(result.rawMessage.text, "这是一段违规词测试");
    assert.match(result.projectedMessage.text, /内容已屏蔽/);
    assert.doesNotMatch(result.projectedMessage.text, /违规词测试/);
    assert.equal(result.events.length, 1);

    const record = await harness.store.getByKey(`text:${contentSafetyHashText("这是一段违规词测试")}`);
    assert.ok(record);
    assert.equal(record.originalText, "这是一段违规词测试");
    assert.equal(record.decision, "block");
  } finally {
    await harness.cleanup();
  }
});

test("blocked media is hidden from LLM projection while original file remains auditable", async () => {
  const file = createChatFile("file_blocked", "blocked-image.png");
  const harness = await createHarness([file]);
  try {
    const message = createMessage({
      text: "看图",
      imageIds: ["file_blocked"],
      attachments: [{
        fileId: "file_blocked",
        kind: "image",
        source: "chat_message",
        sourceName: "blocked-image.png",
        mimeType: "image/png",
        semanticKind: "image"
      }]
    });
    const result = await harness.service.moderateIncomingMessage({
      message,
      sessionId: "qqbot:p:test",
      delivery: "onebot"
    });

    assert.deepEqual(result.rawMessage.imageIds, ["file_blocked"]);
    assert.deepEqual(result.projectedMessage.imageIds, []);
    assert.equal(result.projectedMessage.attachments?.length, 0);
    assert.match(result.projectedMessage.text, /图片已屏蔽/);

    const record = await harness.store.getByFileId("file_blocked");
    assert.ok(record);
    assert.equal(record.fileId, "file_blocked");
    assert.equal(record.sourceName, "blocked-image.png");

    const guard = await harness.service.guardChatFileForLlm("file_blocked");
    assert.notEqual(guard, "allow");
  } finally {
    await harness.cleanup();
  }
});

test("enabled content safety without configured providers warns by policy but allows normal projection", async () => {
  const dataDir = createTempDir("content-safety-unconfigured");
  const store = new ContentSafetyStore(dataDir, pino({ level: "silent" }));
  await store.init();
  const service = new ContentSafetyService(
    createTestAppConfig({
      contentSafety: {
        enabled: true,
        profiles: {
          preLlm: {}
        },
        routes: {
          inbound: {
            onebot: "preLlm"
          }
        }
      }
    }),
    pino({ level: "silent" }),
    store,
    {
      async getFile() {
        return null;
      }
    }
  );
  try {
    const message = createMessage({ text: "正常消息" });
    const result = await service.moderateIncomingMessage({
      message,
      sessionId: "qqbot:p:test",
      delivery: "onebot"
    });
    assert.equal(result.projectedMessage.text, "正常消息");
    assert.deepEqual(result.events, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});


import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { TurnPlanner } from "../../src/conversation/turnPlanner.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { LlmGenerateParams } from "../../src/llm/llmClient.ts";

test("turn planner injects image captions for non-vision planner models", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true,
      turnPlanner: {
        enabled: true
      },
      models: {
        main: {
          supportsVision: false
        }
      }
    }
  });

  let ensuredImageIds: string[] = [];
  let capturedPromptText = "";
  const planner = new TurnPlanner(
    config,
    {
      async generate(params: LlmGenerateParams) {
        const userMessage = params.messages[1];
        assert.ok(Array.isArray(userMessage?.content));
        const textPart = userMessage.content.find((item) => item.type === "text");
        assert.equal(textPart?.type, "text");
        capturedPromptText = textPart.text;
        return {
          text: [
            "reason: 含图片信息",
            "reply_decision: reply_small",
            "topic_decision: continue_topic",
            "required_capabilities: none",
            "context_dependencies: none",
            "recent_domain_reuse: none",
            "followup_mode: none",
            "toolset_ids: none"
          ].join("\n")
        };
      }
    } as never,
    {
      async getMany() {
        return [];
      }
    } as never,
    {
      async prepareFilesForModel() {
        throw new Error("non-vision turn planner should not prepare image inputs");
      }
    } as never,
    pino({ level: "silent" }),
    {
      async ensureReady(imageIds: string[]) {
        ensuredImageIds = imageIds;
        return new Map([
          ["file_history_1", "历史里的一张项目看板截图"],
          ["file_image_1", "当前消息里的一张红色折线图截图"],
          ["file_emoji_1", "一个表示震惊的猫咪表情包"],
          ["file_asset_1", "当前消息附件中的部署面板截图"]
        ]);
      }
    }
  );

  const result = await planner.decide({
    sessionId: "web:test",
    chatType: "private",
    relationship: "owner",
    recentMessages: [{
      role: "user",
      content: "上轮这张图\n⟦ref kind=\"image\" image_id=\"file_history_1\"⟧",
      timestampMs: 1
    }],
    availableToolsets: [],
    batchMessages: [{
      senderName: "Owner",
      text: "继续看这些图",
      images: [],
      audioSources: [],
      imageIds: ["file_image_1"],
      emojiIds: ["file_emoji_1"],
      attachments: [{
        fileId: "file_asset_1",
        kind: "image",
        source: "web_upload",
        mimeType: "image/png",
        sourceName: "deploy.png",
        semanticKind: "image"
      }],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      mentionedSelf: false,
      timestampMs: 2
    }]
  });

  assert.equal(result.replyDecision, "reply_small");
  assert.deepEqual(ensuredImageIds, ["file_history_1", "file_image_1", "file_emoji_1", "file_asset_1"]);
  assert.match(capturedPromptText, /图片描述：历史里的一张项目看板截图/);
  assert.match(capturedPromptText, /file_image_1 image 图片描述：当前消息里的一张红色折线图截图/);
  assert.match(capturedPromptText, /file_emoji_1 emoji 表情描述：一个表示震惊的猫咪表情包/);
  assert.match(capturedPromptText, /file_asset_1 image 图片描述：当前消息附件中的部署面板截图/);
});

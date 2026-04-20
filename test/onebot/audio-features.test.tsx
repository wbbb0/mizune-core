import assert from "node:assert/strict";
import { EventRouter } from "../../src/services/onebot/eventRouter.ts";
import { buildUserBatchContent } from "../../src/llm/prompts/trigger-batch.prompt.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

function createConfig() {
  return createTestAppConfig({
    llm: {
      models: {
        main: {
          supportsAudioInput: true
        }
      }
    }
  });
}

async function main() {
  await runCase("event router keeps audio-only messages", async () => {
    const config = createConfig();
    const router = new EventRouter(config, config.configRuntime.instanceName);
    const parsed = router.toIncomingMessage({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 1,
      user_id: 10001,
      message: [
        {
          type: "record",
          data: {
            url: "https://example.com/audio/test.mp3"
          }
        }
      ],
      raw_message: "[CQ:record,file=test.mp3]",
      sender: {
        user_id: 10001,
        nickname: "Tester"
      },
      self_id: 20002,
      time: Math.floor(Date.now() / 1000)
    });

    assert.equal(parsed?.text, "");
    assert.deepEqual(parsed?.audioSources, ["https://example.com/audio/test.mp3"]);
  });

  await runCase("prompt formatting attaches input_audio parts", async () => {
    const content = buildUserBatchContent([{
      userId: "10001",
      senderName: "Tester",
      text: "",
      images: [],
      audioSources: ["https://example.com/audio/test.mp3"],
      audioIds: [],
      audioInputs: [{
        source: "https://example.com/audio/test.mp3",
        mimeType: "audio/mpeg",
        format: "mp3",
        data: "ZmFrZQ=="
      }],
      emojiSources: [],
      imageIds: [],
      emojiIds: [],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      mentionedSelf: false,
      timestampMs: Date.now()
    }]);

    assert.equal(content.some((part) => part.type === "input_audio"), true);
    const audioPart = content.find((part) => part.type === "input_audio");
    assert.equal(audioPart?.input_audio.format, "mp3");
    assert.equal(audioPart?.input_audio.mimeType, "audio/mpeg");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

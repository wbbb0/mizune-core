import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import {
  composeToolLoopCheckpointMessage,
  generateToolLoopCheckpointReport,
  isCheckpointReportBodyAcceptable
} from "../../src/app/generation/toolLoopCheckpointReporter.ts";
import type { SessionTaskTracker } from "../../src/conversation/taskTracker/taskTrackerTypes.ts";
import type { ToolLoopCheckpointObservation } from "../../src/llm/prompts/tool-loop-checkpoint.prompt.ts";
import { createLlmTestConfig, withMockFetch } from "../helpers/llm-test-support.tsx";

const tracker: SessionTaskTracker = {
  version: 1,
  primary: {
    taskId: "task-1",
    status: "active",
    objective: "检查项目并运行测试",
    originalRequest: "检查项目并运行测试",
    done: ["已经检查配置文件"],
    next: ["运行剩余测试"],
    blockers: [],
    importantToolRefs: [],
    createdAtMs: 1,
    updatedAtMs: 2
  },
  parked: []
};

const observations: ToolLoopCheckpointObservation[] = [{
  toolName: "filesystem_read",
  toolCallId: "call-1",
  outcome: "succeeded",
  summary: "已读取 config/global.yml",
  timestampMs: 2,
  contentHash: "hash-1",
  resource: { kind: "filesystem", id: "config/global.yml" }
}];

test("checkpoint reporter rejects DSML tool protocol and uses deterministic facts", async () => {
  const config = createLlmTestConfig({});
  config.llm.summarizer.enabled = true;
  const client = new LlmClient(config, pino({ level: "silent" }));

  await withMockFetch([{
    assertRequest(body: any) {
      assert.equal(body.messages.length, 2);
      assert.match(body.messages[0].content, /不得输出 DSML/);
      assert.ok(!body.tools || body.tools.length === 0);
      assert.doesNotMatch(JSON.stringify(body.messages), /assistant_tool_call/);
    },
    payloads: [
      {
        choices: [{
          delta: {
            content: "<｜DSML｜tool_calls><｜DSML｜invoke name=\"delete\"></｜DSML｜invoke></｜DSML｜tool_calls>"
          }
        }]
      },
      {
        usage: {
          prompt_tokens: 30,
          completion_tokens: 8,
          total_tokens: 38
        }
      }
    ]
  }], async () => {
    const result = await generateToolLoopCheckpointReport({
      config,
      llmClient: client,
      logger: pino({ level: "silent" }),
      sessionId: "session-1",
      modeId: "default",
      originalRequest: "检查项目并运行测试",
      taskTracker: tracker,
      observations,
      persona: { name: "测试助手", temperament: "冷静", voiceStyle: "简洁" },
      sessionBotProfile: null,
      abortSignal: new AbortController().signal,
      assertCurrent() {}
    });

    assert.equal(result.modelGenerated, false);
    assert.match(result.body, /已经检查配置文件/);
    assert.doesNotMatch(result.body, /DSML|delete/);
    assert.equal(result.usage?.requestCount, 1);
  });
});

test("checkpoint reporter accounts for rejected structured tool-call usage without exposing token stats", async () => {
  const config = createLlmTestConfig({});
  config.llm.summarizer.enabled = true;
  const client = new LlmClient(config, pino({ level: "silent" }));

  await withMockFetch([{
    assertRequest(body: any) {
      assert.ok(!body.tools || body.tools.length === 0);
    },
    payloads: [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "unexpected-delete",
              type: "function",
              function: {
                name: "delete",
                arguments: "{\"path\":\"unexpected.txt\"}"
              }
            }]
          }
        }]
      },
      {
        usage: {
          prompt_tokens: 25,
          completion_tokens: 6,
          total_tokens: 31
        }
      }
    ]
  }], async () => {
    const result = await generateToolLoopCheckpointReport({
      config,
      llmClient: client,
      logger: pino({ level: "silent" }),
      sessionId: "session-1",
      modeId: "default",
      originalRequest: "检查项目并运行测试",
      taskTracker: tracker,
      observations,
      persona: { name: "测试助手", temperament: "冷静", voiceStyle: "简洁" },
      sessionBotProfile: null,
      abortSignal: new AbortController().signal,
      assertCurrent() {}
    });

    assert.equal(result.modelGenerated, false);
    assert.equal(result.usage?.requestCount, 1);
    assert.deepEqual(result.providerCallUsages.map((item) => item.phase), ["invalid_response"]);
    assert.equal(result.finalProviderCallUsage, null);
    assert.doesNotMatch(result.body, /delete|unexpected/);
  });
});

test("checkpoint composer appends live state and one fixed confirmation question", () => {
  const message = composeToolLoopCheckpointMessage({
    body: "我已经完成配置检查。",
    liveResourceLines: ["下载 res_download_1：仍在运行，进度 50%"]
  });

  assert.match(message, /当前状态：/);
  assert.match(message, /res_download_1/);
  assert.equal(message.match(/你希望我继续处理剩余步骤，还是调整方案或停止？/g)?.length, 1);
  assert.doesNotMatch(message, /工具调用次数|执行额度/);
});

test("checkpoint reporter body contract rejects questions, limits, and whole-task completion claims", () => {
  assert.equal(isCheckpointReportBodyAcceptable("我已经完成了配置检查，并发现一个路径错误。"), true);
  assert.equal(isCheckpointReportBodyAcceptable("任务已经全部完成。"), false);
  assert.equal(isCheckpointReportBodyAcceptable("工具调用达到上限，你希望我继续吗？"), false);
  assert.equal(isCheckpointReportBodyAcceptable("<｜｜DSML｜｜tool_calls>"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildGenerationFailureAssistantMessage } from "../../src/app/generation/generationExecutorSupport.ts";
import { projectProviderPreflightMessages } from "../../src/app/generation/generationExecutor.ts";

  test("buildGenerationFailureAssistantMessage returns stable fallback text", async () => {
    assert.equal(
      buildGenerationFailureAssistantMessage(),
      "刚刚这次回复失败了，我暂时没拿到可用结果。你可以稍后重试；如果连续出现，请检查模型配置、上游接口状态或服务日志。"
    );
  });

test("projectProviderPreflightMessages preserves stable system prefix", async () => {
  const messages = [
    { role: "system" as const, content: "stable system" },
    { role: "system" as const, content: "dynamic system" },
    { role: "user" as const, content: "hello" }
  ];
  const projected = await projectProviderPreflightMessages({
    messages,
    async project(projectableMessages) {
      assert.deepEqual(projectableMessages.map((message) => message.content), ["dynamic system", "hello"]);
      return projectableMessages.map((message) => ({
        ...message,
        content: `${message.content} projected`
      }));
    }
  });

  assert.deepEqual(projected.map((message) => message.content), [
    "stable system",
    "dynamic system projected",
    "hello projected"
  ]);
});

test("projectProviderPreflightMessages projects all messages when stable system prefix is absent", async () => {
  const messages = [
    { role: "user" as const, content: "hello" }
  ];
  const projected = await projectProviderPreflightMessages({
    messages,
    async project(projectableMessages) {
      assert.deepEqual(projectableMessages.map((message) => message.content), ["hello"]);
      return projectableMessages;
    }
  });

  assert.equal(projected, messages);
});

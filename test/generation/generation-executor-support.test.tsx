import test from "node:test";
import assert from "node:assert/strict";
import { buildGenerationFailureAssistantMessage } from "../../src/app/generation/generationExecutorSupport.ts";

  test("buildGenerationFailureAssistantMessage returns stable fallback text", async () => {
    assert.equal(
      buildGenerationFailureAssistantMessage(),
      "刚刚这次回复失败了，我暂时没拿到可用结果。你可以稍后重试；如果连续出现，请检查模型配置、上游接口状态或服务日志。"
    );
  });

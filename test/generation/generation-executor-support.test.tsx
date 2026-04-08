import assert from "node:assert/strict";
import {
  buildGenerationFailureAssistantMessage,
  extractToolContent,
  summarizeResultText,
  summarizeToolArgs,
  summarizeToolResult
} from "../../src/app/generation/generationExecutorSupport.ts";
import { runCase } from "../helpers/forward-test-support.tsx";

async function main() {
  await runCase("buildGenerationFailureAssistantMessage returns stable fallback text", async () => {
    assert.equal(
      buildGenerationFailureAssistantMessage(),
      "刚刚这次回复失败了，我暂时没拿到可用结果。你可以稍后重试；如果连续出现，请检查模型配置、上游接口状态或服务日志。"
    );
  });

  await runCase("summarizeToolArgs normalizes spaces and truncates long text", async () => {
    const text = `  hello\n\n${"world ".repeat(80)}  `;
    const summarized = summarizeToolArgs(text);

    assert.equal(/\s{2,}/.test(summarized), false);
    assert.equal(summarized.endsWith("..."), true);
    assert.equal(summarized.length <= 183, true);
  });

  await runCase("summarizeToolResult extracts explicit json error messages", async () => {
    const summarized = summarizeToolResult('{"error":"tool failed: timeout"}');
    assert.equal(summarized, "tool failed: timeout");
  });

  await runCase("summarizeToolResult handles terminal and object results", async () => {
    const terminal = summarizeToolResult({
      content: '{"ok":true}',
      terminalResponse: {
        content: "done",
        shouldContinue: false
      }
    } as any);
    assert.equal(terminal, "terminal response");

    const fromObject = summarizeToolResult({
      content: '{"result":"ok"}'
    } as any);
    assert.equal(fromObject, '{"result":"ok"}');
  });

  await runCase("extractToolContent and summarizeResultText keep core text semantics", async () => {
    const content = extractToolContent({ content: "  one\n two\n" } as any);
    assert.equal(content, "  one\n two\n");

    const summarized = summarizeResultText("  alpha\n beta\n gamma ", 10);
    assert.equal(summarized, "alpha beta...");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

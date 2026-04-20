import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeOutboundText } from "../../src/llm/shared/outboundTextSanitizer.ts";

  test("strips list markers while keeping content", () => {
    const input = [
      "- 第一项",
      "* 第二项",
      "+ 第三项",
      "1. 第四项",
      "2) 第五项"
    ].join("\n");

    assert.equal(
      sanitizeOutboundText(input),
      ["第一项", "第二项", "第三项", "第四项", "第五项"].join("\n")
    );
  });

  test("strips inline code wrappers", () => {
    assert.equal(
      sanitizeOutboundText("你先运行 `npm run build`，再看 `dist/index.js`。"),
      "你先运行 npm run build，再看 dist/index.js。"
    );
  });

  test("strips bold and italic wrappers without touching plain underscores", () => {
    assert.equal(
      sanitizeOutboundText("这是 **重点**，也是 *提示*，变量名保留为 user_name。"),
      "这是 重点，也是 提示，变量名保留为 user_name。"
    );
  });

  test("handles mixed markdown-like chat output", () => {
    const input = [
      "1. **先别急**",
      "2. 看一下 `npm run build` 的输出",
      "3. 如果还是不行，再把 *报错原文* 发我"
    ].join("\n");

    assert.equal(
      sanitizeOutboundText(input),
      ["先别急", "看一下 npm run build 的输出", "如果还是不行，再把 报错原文 发我"].join("\n")
    );
  });

  test("strips leading prompt-style message headers when requested", () => {
    const input = [
      "⟦trigger_batch session=\"群聊 123456\" trigger_user=\"Bob (10002)\" message_count=\"2\" speaker_count=\"2\"⟧",
      "⟦trigger_message index=\"1\" speaker=\"Alice (10001)\" trigger_user=\"no\" time=\"2026/03/16 17:13:00\"⟧",
      "",
      "那我先回 Bob 这句。"
    ].join("\n");

    assert.equal(
      sanitizeOutboundText(input, { stripLeadingMessageHeaders: true }),
      "那我先回 Bob 这句。"
    );
  });

  test("keeps prompt-style message headers when stripping is not requested", () => {
    const input = "⟦trigger_message index=\"1\" speaker=\"Alice (10001)\" trigger_user=\"yes\" time=\"2026/03/16 17:13:00\"⟧\n收到啦";

    assert.equal(
      sanitizeOutboundText(input),
      "收到啦"
    );
  });

  test("strips standalone structured bracket lines in the middle of output", () => {
    const input = [
      "先说结论",
      "⟦section name=\"debug\"⟧",
      "再补一句"
    ].join("\n");

    assert.equal(
      sanitizeOutboundText(input),
      ["先说结论", "再补一句"].join("\n")
    );
  });

  test("keeps bracket tokens when they are part of a normal sentence", () => {
    const input = "这个符号⟦不是整行标签⟧要保留";
    assert.equal(sanitizeOutboundText(input), input);
  });

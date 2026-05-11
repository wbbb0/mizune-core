import test from "node:test";
import assert from "node:assert/strict";
import { formatScenarioHostStructuredUserContent } from "../../src/modes/scenarioHost/promptInputProtocol.ts";
import { buildCloseTag, buildOpenTag } from "../../src/utils/structuredEnvelope.ts";

test("scenario host keeps normal angle-bracket lines as player speech", () => {
  assert.equal(
    formatScenarioHostStructuredUserContent([
      "<角色低语>",
      "继续向前"
    ].join("\n")),
    [
      "玩家对白：<角色低语>",
      "继续向前"
    ].join("\n")
  );
});

test("scenario host skips only internal protocol lines before rewriting user content", () => {
  assert.equal(
    formatScenarioHostStructuredUserContent([
      buildOpenTag("trigger_message", { index: "1", speaker: "Alice", trigger_user: "yes", time: "2026/03/16 17:13:00" }),
      "*推门进入",
      buildCloseTag("trigger_message")
    ].join("\n")),
    [
      buildOpenTag("trigger_message", { index: "1", speaker: "Alice", trigger_user: "yes", time: "2026/03/16 17:13:00" }),
      "玩家动作：推门进入",
      buildCloseTag("trigger_message")
    ].join("\n")
  );
});

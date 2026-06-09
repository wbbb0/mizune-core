import test from "node:test";
import assert from "node:assert/strict";
import {
  formatScenarioHostParsedUserInput,
  formatScenarioHostStructuredUserContent,
  parseScenarioHostUserInput
} from "../../src/modes/scenarioHost/promptInputProtocol.ts";
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

test("scenario host rewrites each non-tag paragraph independently", () => {
  assert.equal(
    formatScenarioHostStructuredUserContent([
      buildOpenTag("trigger_message", { index: "1", speaker: "Alice", trigger_user: "yes", time: "2026/03/16 17:13:00" }),
      "#慢一点",
      "",
      "*我推门",
      "",
      "**",
      "",
      "里面有人吗",
      buildCloseTag("trigger_message")
    ].join("\n")),
    [
      buildOpenTag("trigger_message", { index: "1", speaker: "Alice", trigger_user: "yes", time: "2026/03/16 17:13:00" }),
      "场外指令：慢一点",
      "",
      "玩家动作：我推门",
      "",
      "代行玩家动作：玩家请求你代为选择并执行下一步玩家角色行动；请基于当前局面、角色资料和已知风险做出合理的一小步行动。",
      "",
      "玩家对白：里面有人吗",
      buildCloseTag("trigger_message")
    ].join("\n")
  );
});

test("scenario host treats a single star as auto advance", () => {
  const parsed = parseScenarioHostUserInput("*");
  assert.deepEqual(parsed, {
    kind: "auto_advance",
    content: "玩家没有声明新的具体动作，请基于当前局面自然推进下一步。"
  });
  assert.equal(
    formatScenarioHostParsedUserInput(parsed),
    "自动推进：玩家没有声明新的具体动作，请基于当前局面自然推进下一步。"
  );
});

test("scenario host treats double star as delegated player action", () => {
  const parsed = parseScenarioHostUserInput("**");
  assert.deepEqual(parsed, {
    kind: "delegated_player_action",
    content: "玩家请求你代为选择并执行下一步玩家角色行动；请基于当前局面、角色资料和已知风险做出合理的一小步行动。"
  });
  assert.equal(
    formatScenarioHostParsedUserInput(parsed),
    "代行玩家动作：玩家请求你代为选择并执行下一步玩家角色行动；请基于当前局面、角色资料和已知风险做出合理的一小步行动。"
  );
});

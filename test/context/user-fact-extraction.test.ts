import test from "node:test";
import assert from "node:assert/strict";
import { extractExplicitUserFactCandidates } from "../../src/context/userFactExtraction.ts";

test("extractExplicitUserFactCandidates keeps explicit remember commands", () => {
  assert.deepEqual(extractExplicitUserFactCandidates("记住我喜欢 Orama 版上下文检索"), [{
    title: "我喜欢 Orama 版上下文检索",
    content: "我喜欢 Orama 版上下文检索",
    kind: "preference"
  }]);
});

test("extractExplicitUserFactCandidates extracts stable first-person habits", () => {
  assert.deepEqual(extractExplicitUserFactCandidates("我早餐固定吃希腊酸奶加蓝莓和奇亚籽。你先回复收到。"), [{
    title: "早餐习惯",
    content: "早餐固定吃希腊酸奶加蓝莓和奇亚籽",
    kind: "habit"
  }]);
});

test("extractExplicitUserFactCandidates extracts user updates into the same slot", () => {
  assert.deepEqual(extractExplicitUserFactCandidates("更新一下，我早餐改成全麦吐司配牛油果，不再吃酸奶。你先回复收到。"), [{
    title: "早餐习惯",
    content: "早餐改成全麦吐司配牛油果，不再吃酸奶",
    kind: "habit"
  }]);
});

test("extractExplicitUserFactCandidates does not turn questions into facts", () => {
  assert.deepEqual(extractExplicitUserFactCandidates("我现在早餐一般吃什么？只回答食物"), []);
});

test("extractExplicitUserFactCandidates does not store temporary observations", () => {
  assert.deepEqual(extractExplicitUserFactCandidates("我今天早餐吃了包子"), []);
  assert.deepEqual(extractExplicitUserFactCandidates("我现在用电脑处理一下文件"), []);
  assert.deepEqual(extractExplicitUserFactCandidates("我刚才喝了咖啡"), []);
});

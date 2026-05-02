import test from "node:test";
import assert from "node:assert/strict";
import { selectRetrievedUserContext } from "../../src/context/contextSelectionPolicy.ts";
import type { ContextRetrievedItem } from "../../src/context/contextTypes.ts";

test("selectRetrievedUserContext keeps canonical facts and suppresses stale conflicting history", () => {
  const results = selectRetrievedUserContext({
    queryText: "我现在早餐一般吃什么",
    alwaysItems: [
      item("fact_breakfast", "fact", "早餐固定吃全麦吐司配牛油果", {
        title: "早餐习惯",
        updatedAt: 20,
        score: 1
      })
    ],
    searchItems: [
      item("old_chunk", "chunk", "用户：我早餐固定吃希腊酸奶加蓝莓和奇亚籽。", {
        updatedAt: 10,
        score: 0.91
      }),
      item("update_chunk", "chunk", "用户：更新一下，我早餐改成全麦吐司配牛油果，不再吃酸奶。", {
        updatedAt: 19,
        score: 0.62
      })
    ],
    maxResults: 4
  });

  assert.deepEqual(results.map((result) => result.itemId), ["fact_breakfast", "update_chunk"]);
});

test("selectRetrievedUserContext preserves older chunks for historical queries", () => {
  const results = selectRetrievedUserContext({
    queryText: "我以前早餐吃什么",
    alwaysItems: [
      item("fact_breakfast", "fact", "早餐固定吃全麦吐司配牛油果", {
        title: "早餐习惯",
        updatedAt: 20,
        score: 1
      })
    ],
    searchItems: [
      item("old_chunk", "chunk", "用户：我早餐固定吃希腊酸奶加蓝莓和奇亚籽。", {
        updatedAt: 10,
        score: 0.91
      })
    ],
    maxResults: 4
  });

  assert.deepEqual(results.map((result) => result.itemId), ["fact_breakfast", "old_chunk"]);
});

test("selectRetrievedUserContext does not suppress newer observations after a fact", () => {
  const results = selectRetrievedUserContext({
    queryText: "我早餐一般吃什么",
    alwaysItems: [
      item("fact_breakfast", "fact", "早餐固定吃全麦吐司配牛油果", {
        title: "早餐习惯",
        updatedAt: 20,
        score: 1
      })
    ],
    searchItems: [
      item("newer_chunk", "chunk", "用户：今天早餐临时吃了燕麦杯。", {
        updatedAt: 30,
        score: 0.7
      })
    ],
    maxResults: 4
  });

  assert.deepEqual(results.map((result) => result.itemId), ["fact_breakfast", "newer_chunk"]);
});

function item(
  itemId: string,
  sourceType: ContextRetrievedItem["sourceType"],
  text: string,
  overrides: Partial<ContextRetrievedItem> = {}
): ContextRetrievedItem {
  return {
    itemId,
    scope: "user",
    sourceType,
    userId: "user_1",
    text,
    score: 0.5,
    updatedAt: 1,
    ...overrides
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  hasDiceRollSignal,
  parseDiceExpression,
  rollDiceExpression
} from "../../src/llm/tools/runtime/diceExpression.ts";
import { diceToolHandlers } from "../../src/llm/tools/runtime/diceTools.ts";

test("dice parser accepts multi-term expressions and normalizes shorthand", () => {
  const parsed = parseDiceExpression(" 3d6 + 5 + D20 + d% ");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.expression : "", "3D6+5+1D20+1D100");
  assert.equal(parsed.ok ? parsed.terms.length : 0, 4);
});

test("dice roller evaluates complex expression with injected random sequence", () => {
  const values = [3, 4, 5, 17];
  const result = rollDiceExpression("3D6+5+1D20", () => {
    const value = values.shift();
    assert.equal(typeof value, "number");
    return value!;
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.total : 0, 34);
  assert.equal(result.ok ? result.detailFormula : "", "(3 + 4 + 5) + 5 + (17) = 34");
  assert.equal(result.ok ? result.shortText : "", "3D6+5+1D20 = 34");
  assert.equal(result.ok ? result.replyText : "", "3D6+5+1D20: (3 + 4 + 5) + 5 + (17) = 34");
  assert.equal(result.ok ? result.text : "", "3D6+5+1D20: (3 + 4 + 5) + 5 + (17) = 34");
});

test("dice roller formats detail formula for small-model direct replies", () => {
  const values = [2, 2, 3, 4];
  const result = rollDiceExpression("3d4+2+1d6", () => values.shift()!);

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.detailFormula : "", "(2 + 2 + 3) + 2 + (4) = 13");
  assert.equal(result.ok ? result.replyText : "", "3D4+2+1D6: (2 + 2 + 3) + 2 + (4) = 13");
});

test("dice parser rejects unsafe or non-dice expressions", () => {
  assert.equal(parseDiceExpression("5+6").ok, false);
  const tooManyDice = parseDiceExpression("201D6");
  const trailingOperator = parseDiceExpression("1D6+");

  assert.equal(tooManyDice.ok, false);
  assert.equal(trailingOperator.ok, false);
  assert.match(tooManyDice.ok ? "" : tooManyDice.error, /too many dice/u);
  assert.match(trailingOperator.ok ? "" : trailingOperator.error, /end with an operator/u);
});

test("dice signal detector catches embedded notation and dice verbs", () => {
  assert.equal(hasDiceRollSignal("帮我投 3D6+5+1D20"), true);
  assert.equal(hasDiceRollSignal("投个骰子"), true);
  assert.equal(hasDiceRollSignal("3D 打印不是骰子表达式"), false);
});

test("roll_dice handler returns structured JSON", async () => {
  const result = await diceToolHandlers.roll_dice!(
    { id: "tool_dice_1", type: "function", function: { name: "roll_dice", arguments: "{\"expression\":\"D6\"}" } },
    { expression: "D6" },
    {} as any
  );
  const payload = JSON.parse(String(result));

  assert.equal(payload.ok, true);
  assert.equal(payload.expression, "1D6");
  assert.equal(payload.terms.length, 1);
  assert.equal(payload.terms[0].rolls.length, 1);
});

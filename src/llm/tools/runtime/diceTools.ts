import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { rollDiceExpression, type DiceRollResult } from "./diceExpression.ts";

export const diceToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "roll_dice",
        description: "投骰并计算表达式。支持 NdM、D20、D%、整数和 +/-，例如 3D6+5+1D20。",
        parameters: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "骰子表达式，例如 3D6+5+1D20；不写数量时 D20 表示 1D20。"
            }
          },
          required: ["expression"],
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 5 })
  }
];

export const diceToolHandlers: Record<string, ToolHandler> = {
  async roll_dice(_toolCall, args) {
    const expression = getStringArg(args, "expression");
    const result = rollDiceExpression(expression);
    return JSON.stringify(result.ok ? compactDiceRollResult(result) : result);
  }
};

function compactDiceRollResult(result: DiceRollResult) {
  return {
    ok: true,
    expression: result.expression,
    total: result.total,
    formula: result.detailFormula,
    terms: result.terms.map((term) => {
      if (term.kind === "number") {
        return {
          kind: "number",
          sign: term.sign,
          value: term.value,
          subtotal: term.subtotal
        };
      }
      return {
        kind: "dice",
        sign: term.sign,
        notation: term.notation,
        rolls: term.rolls,
        subtotal: term.subtotal
      };
    })
  };
}

import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getBooleanArg, getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { projectToolResult, type JsonObject } from "../core/toolResultProjection.ts";
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
            },
            details: {
              type: "boolean",
              description: "是否返回逐项 rolls 明细；默认 false，只返回总点数和公式。"
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
    const details = getBooleanArg(args, "details") === true;
    const result = rollDiceExpression(expression);
    return projectToolResult({
      toolName: "roll_dice",
      canonical: result as unknown as JsonObject,
      ...projectionArgs(args),
      projection: {
        initial: (canonical) => canonical.ok === true
          ? compactDiceRollResult(canonical as unknown as DiceRollResult, { details })
          : canonical
      }
    });
  }
};

function compactDiceRollResult(result: DiceRollResult, options: { details: boolean }): JsonObject {
  const compact = {
    ok: true,
    expression: result.expression,
    total: result.total,
    formula: result.detailFormula
  };
  if (!options.details) {
    return compact;
  }
  return {
    ...compact,
    terms: result.terms.map(compactDiceRollTerm)
  };
}

function compactDiceRollTerm(term: DiceRollResult["terms"][number]) {
  if (term.kind === "number") {
    return {
      kind: "number" as const,
      sign: term.sign,
      value: term.value,
      subtotal: term.subtotal
    };
  }
  return {
    kind: "dice" as const,
    sign: term.sign,
    notation: term.notation,
    rolls: term.rolls,
    subtotal: term.subtotal
  };
}

function projectionArgs(args: unknown): { args?: Record<string, unknown> } {
  return args && typeof args === "object" ? { args: args as Record<string, unknown> } : {};
}

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { LlmToolCall, LlmToolDefinition } from "./provider/providerTypes.ts";
import { parseNormalizedToolArguments } from "./shared/toolArgs.ts";

const MAX_TOOL_CALLS_PER_BATCH = 32;
const MAX_TOOL_CALL_PAYLOAD_CHARS = 256_000;
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const DSML_TOOL_ENVELOPE = /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*tool_calls\s*>[\s\S]*?<\/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*tool_calls\s*>/iu;

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validatorCache = new WeakMap<object, ValidateFunction>();

export type ToolCallEnvelopeIssueCode =
  | "dsml_tool_envelope"
  | "too_many_tool_calls"
  | "tool_call_payload_too_large"
  | "invalid_tool_call_shape"
  | "missing_tool_call_id"
  | "duplicate_tool_call_id"
  | "invalid_tool_name";

export interface ToolCallEnvelopeIssue {
  code: ToolCallEnvelopeIssueCode;
  message: string;
}

export type ToolCallEnvelopeValidation =
  | { ok: true }
  | { ok: false; issues: ToolCallEnvelopeIssue[] };

export type ToolCallRejectionCode =
  | "tool_not_available"
  | "invalid_arguments_json"
  | "invalid_arguments_root"
  | "arguments_schema_mismatch";

export type ToolCallClassification =
  | {
      kind: "executable";
      toolCall: LlmToolCall;
    }
  | {
      kind: "rejected";
      toolCall: LlmToolCall;
      code: ToolCallRejectionCode;
      message: string;
    };

export function validateToolCallEnvelope(input: {
  text: string;
  toolCalls: LlmToolCall[];
}): ToolCallEnvelopeValidation {
  const issues: ToolCallEnvelopeIssue[] = [];

  if (containsDsmlToolEnvelope(input.text)) {
    issues.push({
      code: "dsml_tool_envelope",
      message: "响应正文包含完整的 DSML 工具调用协议。"
    });
  }
  if (input.toolCalls.length > MAX_TOOL_CALLS_PER_BATCH) {
    issues.push({
      code: "too_many_tool_calls",
      message: `单批工具调用数量超过 ${MAX_TOOL_CALLS_PER_BATCH}。`
    });
  }

  const ids = new Set<string>();
  let totalPayloadChars = 0;
  for (const value of input.toolCalls as unknown[]) {
    if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) {
      issues.push({
        code: "invalid_tool_call_shape",
        message: "工具调用结构不完整。"
      });
      continue;
    }
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const name = typeof value.function.name === "string" ? value.function.name.trim() : "";
    const argumentsText = typeof value.function.arguments === "string"
      ? value.function.arguments
      : null;

    if (!id) {
      issues.push({
        code: "missing_tool_call_id",
        message: "工具调用缺少可关联的调用 ID。"
      });
    } else if (ids.has(id)) {
      issues.push({
        code: "duplicate_tool_call_id",
        message: "同一批响应包含重复的工具调用 ID。"
      });
    } else {
      ids.add(id);
    }

    if (!name || !TOOL_NAME_PATTERN.test(name)) {
      issues.push({
        code: "invalid_tool_name",
        message: "工具调用名称为空或不符合协议。"
      });
    }
    if (argumentsText === null) {
      issues.push({
        code: "invalid_tool_call_shape",
        message: "工具调用参数不是字符串。"
      });
    } else {
      totalPayloadChars += argumentsText.length;
    }
  }

  if (totalPayloadChars > MAX_TOOL_CALL_PAYLOAD_CHARS) {
    issues.push({
      code: "tool_call_payload_too_large",
      message: `单批工具调用参数总长度超过 ${MAX_TOOL_CALL_PAYLOAD_CHARS}。`
    });
  }

  return issues.length > 0
    ? { ok: false, issues: deduplicateEnvelopeIssues(issues) }
    : { ok: true };
}

export function classifyToolCalls(
  toolCalls: LlmToolCall[],
  advertisedTools: LlmToolDefinition[]
): ToolCallClassification[] {
  const advertisedByName = new Map(
    advertisedTools.map((tool) => [tool.function.name, tool] as const)
  );

  return toolCalls.map((toolCall): ToolCallClassification => {
    const definition = advertisedByName.get(toolCall.function.name);
    if (!definition) {
      return {
        kind: "rejected",
        toolCall,
        code: "tool_not_available",
        message: `工具 ${toolCall.function.name} 当前轮未开放，调用没有执行。`
      };
    }

    let parsed: unknown;
    try {
      parsed = parseNormalizedToolArguments(toolCall.function.arguments);
    } catch {
      return {
        kind: "rejected",
        toolCall,
        code: "invalid_arguments_json",
        message: `工具 ${toolCall.function.name} 的参数不是有效 JSON，调用没有执行。`
      };
    }
    if (!isRecord(parsed)) {
      return {
        kind: "rejected",
        toolCall,
        code: "invalid_arguments_root",
        message: `工具 ${toolCall.function.name} 的参数根节点必须是对象，调用没有执行。`
      };
    }

    const validation = validateArguments(definition.function.parameters, parsed);
    if (!validation.ok) {
      return {
        kind: "rejected",
        toolCall,
        code: "arguments_schema_mismatch",
        message: `工具 ${toolCall.function.name} 的参数不符合要求：${validation.message}，调用没有执行。`
      };
    }
    return { kind: "executable", toolCall };
  });
}

export function containsDsmlToolEnvelope(text: string): boolean {
  return DSML_TOOL_ENVELOPE.test(text);
}

export function deduplicateEnvelopeIssues(
  issues: ToolCallEnvelopeIssue[]
): ToolCallEnvelopeIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function validateArguments(
  schema: Record<string, unknown>,
  value: Record<string, unknown>
): { ok: true } | { ok: false; message: string } {
  let validator: ValidateFunction;
  try {
    const cached = validatorCache.get(schema);
    validator = cached ?? ajv.compile(schema);
    if (!cached) {
      validatorCache.set(schema, validator);
    }
  } catch {
    return { ok: false, message: "工具参数定义不可用" };
  }
  if (validator(value)) {
    return { ok: true };
  }
  return {
    ok: false,
    message: formatValidationErrors(validator.errors)
  };
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (!first) {
    return "参数校验失败";
  }
  const path = first.instancePath || "/";
  return `${path} ${first.message ?? "不符合定义"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

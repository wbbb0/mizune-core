import type { LlmToolExecutionResult, LlmMessage } from "#llm/llmClient.ts";

export type ToolResultProjectionMode = "initial";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface ToolResultProjectionContext {
  toolName: string;
  mode: ToolResultProjectionMode;
  args?: Record<string, unknown>;
}

export type ToolResultProjector<TCanonical extends JsonValue = JsonValue> = (
  canonical: TCanonical,
  context: ToolResultProjectionContext
) => JsonValue;

export interface ToolResultProjection<TCanonical extends JsonValue = JsonValue> {
  initial: ToolResultProjector<TCanonical>;
}

export interface ProjectedToolResultOptions<TCanonical extends JsonValue = JsonValue> {
  toolName: string;
  canonical: TCanonical;
  projection: ToolResultProjection<TCanonical>;
  args?: Record<string, unknown>;
  supplementalMessages?: LlmMessage[];
  terminalResponse?: LlmToolExecutionResult["terminalResponse"];
}

export function projectToolResult<TCanonical extends JsonValue>(
  options: ProjectedToolResultOptions<TCanonical>
): LlmToolExecutionResult {
  const canonicalContent = stringifyToolResult(options.canonical);
  const initial = options.projection.initial(options.canonical, {
    toolName: options.toolName,
    mode: "initial",
    ...(options.args ? { args: options.args } : {})
  });
  return {
    content: stringifyToolResult(initial),
    canonicalContent,
    ...(options.supplementalMessages ? { supplementalMessages: options.supplementalMessages } : {}),
    ...(options.terminalResponse ? { terminalResponse: options.terminalResponse } : {}),
    toString() {
      return this.content;
    }
  };
}

export function projectIdentityToolResult<TCanonical extends JsonValue>(
  toolName: string,
  canonical: TCanonical,
  options?: {
    args?: Record<string, unknown>;
    supplementalMessages?: LlmMessage[];
    terminalResponse?: LlmToolExecutionResult["terminalResponse"];
  }
): LlmToolExecutionResult {
  return projectToolResult({
    toolName,
    canonical,
    projection: {
      initial: (value) => value
    },
    ...(options?.args ? { args: options.args } : {}),
    ...(options?.supplementalMessages ? { supplementalMessages: options.supplementalMessages } : {}),
    ...(options?.terminalResponse ? { terminalResponse: options.terminalResponse } : {})
  });
}

export function projectRawToolContent(_toolName: string, content: string): LlmToolExecutionResult {
  return {
    content,
    canonicalContent: content,
    toString() {
      return this.content;
    }
  };
}

export function stringifyToolResult(value: JsonValue): string {
  return JSON.stringify(value) ?? "null";
}

export function projectFields<TCanonical extends JsonObject>(
  fields: readonly (keyof TCanonical & string)[]
): ToolResultProjector<TCanonical> {
  return (canonical) => pickFields(canonical, fields);
}

export function pickFields<TCanonical extends JsonObject>(
  canonical: TCanonical,
  fields: readonly (keyof TCanonical & string)[]
): JsonObject {
  const projected: JsonObject = {};
  for (const field of fields) {
    if (canonical[field] !== undefined) {
      projected[field] = canonical[field] as JsonValue;
    }
  }
  return projected;
}

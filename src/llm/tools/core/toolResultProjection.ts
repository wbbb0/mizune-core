import type { LlmToolExecutionResult, LlmMessage } from "#llm/llmClient.ts";

export type ToolResultProjectionMode = "initial" | "replay" | "debug";

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

export type ToolResultProjector<TCanonical extends JsonObject = JsonObject> = (
  canonical: TCanonical,
  context: ToolResultProjectionContext
) => JsonObject;

export interface ToolResultProjection<TCanonical extends JsonObject = JsonObject> {
  initial: ToolResultProjector<TCanonical>;
  replay?: ToolResultProjector<TCanonical>;
  debug?: ToolResultProjector<TCanonical>;
}

export interface ProjectedToolResultOptions<TCanonical extends JsonObject = JsonObject> {
  toolName: string;
  canonical: TCanonical;
  projection: ToolResultProjection<TCanonical>;
  args?: Record<string, unknown>;
  supplementalMessages?: LlmMessage[];
  terminalResponse?: LlmToolExecutionResult["terminalResponse"];
}

export function projectToolResult<TCanonical extends JsonObject>(
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
    ...(options.terminalResponse ? { terminalResponse: options.terminalResponse } : {})
  };
}

export function stringifyToolResult(value: JsonObject): string {
  return JSON.stringify(value);
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

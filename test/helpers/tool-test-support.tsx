export function createFunctionToolCall(name: string, id = `${name}_tool`) {
  return {
    id,
    type: "function" as const,
    function: {
      name,
      arguments: "{}"
    }
  };
}

export function parseJsonToolResult<T>(result: unknown): T {
  return JSON.parse(String(result)) as T;
}

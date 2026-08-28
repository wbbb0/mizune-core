export type ProviderProtocolIssueCode =
  | "conflicting_tool_call_index"
  | "invalid_tool_call_type";

export class LlmInvalidProviderResponseError extends Error {
  constructor(
    readonly code: ProviderProtocolIssueCode,
    message: string
  ) {
    super(message);
    this.name = "LlmInvalidProviderResponseError";
  }
}

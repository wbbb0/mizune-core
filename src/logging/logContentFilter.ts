import { safeLogEvents } from "./safeLogEvents.ts";

export const FILTERED_LOG_MESSAGE = "[日志内容已过滤]";

// 正向许可清单：新增业务字段默认不输出，不递归放行任意嵌套数据。
// 字符串仅允许定位请求所需的标识；名称、路径、URL、reason 等自由文本不属于元数据。
const identifierFields = new Set([
  "app", "sessionId", "userId", "groupId", "messageId", "replyMessageId",
  "jobId", "resourceId", "toolCallId", "toolName", "fileId", "modelRef", "model",
  "provider", "providerId", "instanceName"
]);
const numberFields = new Set([
  "level", "time", "pid", "status", "statusCode", "retcode", "durationMs", "timeoutMs",
  "delayMs", "attempt", "candidateIndex", "queueSize", "messageCount", "segmentCount",
  "imageCount", "audioCount", "imageIdCount", "emojiIdCount", "attachmentCount",
  "rawSegmentCount", "fileSegmentCount", "fileSourceCount", "forwardCount", "mentionUserCount",
  "userCount", "groupCount", "deletedCount", "skippedCount", "fileCount", "memoryCount",
  "contextTokens", "safetyTokens", "beforeTokens", "afterTokens", "compactedToolResults",
  "contentLength", "inputTokens", "outputTokens", "totalTokens", "cachedTokens", "reasoningTokens"
]);
const booleanFields = new Set([
  "summaryApplied", "streaming", "shouldFallback", "cancelled", "interrupted", "force", "atMentioned",
  "userMatched", "groupMatched", "directlyAddressed", "mentionedAll"
]);
const errorNames = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "AggregateError"
]);
const errorCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const qqDeliveryCodes = new Set([
  "cancelled", "operation_failed", "http_error", "transport", "invalid_response",
  "invalid_token_response", "invalid_upload_url", "upload_transport", "upload_http",
  "invalid_reply_permit", "reply_permit_expired", "reply_budget_exhausted",
  "invalid_reply_reservation", "reply_permit_capacity", "invalid_media_type",
  "media_source_required", "invalid_media_url", "media_size_limit", "media_name_required",
  "invalid_image_format", "invalid_file_info", "invalid_upload_plan", "invalid_upload_part",
  "incomplete_upload_plan", "missing_message_id", "group_stream_unsupported",
  "stream_closed", "stream_buffer_limit"
]);

/** 接收 Pino 已序列化的整条记录，覆盖格式化消息、Error 和 child bindings。 */
export function filterLogContent(record: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (numberFields.has(key) && typeof value === "number" && Number.isFinite(value)) {
      filtered[key] = value;
    } else if (booleanFields.has(key) && typeof value === "boolean") {
      filtered[key] = value;
    } else if (identifierFields.has(key) && isIdentifier(value)) {
      filtered[key] = value;
    }
  }
  filtered.msg = typeof record.msg === "string" && safeLogEvents.has(record.msg)
    ? record.msg
    : FILTERED_LOG_MESSAGE;
  for (const key of ["err", "error"]) {
    if (record[key] !== undefined) filtered[key] = filterError(record[key]);
  }
  return filtered;
}

function isIdentifier(value: unknown): boolean {
  return (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && /^[a-zA-Z0-9_~:@./-]{1,160}$/.test(value));
}

function filterError(value: unknown): Record<string, unknown> {
  const error = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = typeof value === "string" ? value : error.message;
  const filtered: Record<string, unknown> = { message: filterErrorMessage(message) };
  const name = error.type ?? error.name;
  if (typeof name === "string" && errorNames.has(name)) filtered.name = name;
  if (typeof error.code === "string" && errorCodes.has(error.code)) filtered.code = error.code;
  for (const key of ["status", "statusCode"]) {
    if (typeof error[key] === "number" && Number.isInteger(error[key]) && error[key] >= 100 && error[key] <= 599) {
      filtered[key] = error[key];
    }
  }
  if (name === "QqDeliveryError") filterQqDeliveryError(error, filtered);
  // stack/cause/自定义属性都可能包含上游回显的聊天正文，不保留。
  return filtered;
}

// QQ 投递诊断只保留协议分类；message、URL、响应体、stack/cause 仍按默认策略过滤。
function filterQqDeliveryError(error: Record<string, unknown>, filtered: Record<string, unknown>): void {
  filtered.name = "QqDeliveryError";
  if (error.kind === "rejected" || error.kind === "unknown") filtered.kind = error.kind;
  if (error.stage === "upload" || error.stage === "message" || error.stage === "stream") filtered.stage = error.stage;
  if (error.messageStatus === "not_submitted" || error.messageStatus === "rejected" || error.messageStatus === "unknown") {
    filtered.messageStatus = error.messageStatus;
  } else if (filtered.stage === "upload") {
    // Pino 的 Error serializer 不保证保留 prototype getter。
    filtered.messageStatus = "not_submitted";
  } else if (filtered.stage && filtered.kind) {
    filtered.messageStatus = filtered.kind;
  }
  const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? String(error.code) : error.code;
  if (typeof code === "string" && (/^\d{1,10}$/.test(code) || qqDeliveryCodes.has(code))) filtered.code = code;
  if (typeof error.httpStatus === "number" && Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) {
    filtered.httpStatus = error.httpStatus;
  }
}

function filterErrorMessage(value: unknown): string {
  if (typeof value !== "string") return FILTERED_LOG_MESSAGE;
  if (/^LLM (?:first token|total|thinking) timeout after \d{1,10}ms$/.test(value)) return value;
  const apiStatus = /^LLM API error: ([1-5]\d{2})(?:\s|$)/.exec(value)?.[1];
  if (apiStatus) return `LLM API error: ${apiStatus}`;
  if (value === "fetch failed" || value === "This operation was aborted") return value;
  return FILTERED_LOG_MESSAGE;
}

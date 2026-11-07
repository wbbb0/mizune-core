export interface QqOfficialConfig {
  enabled?: boolean;
  appId: string;
  appSecret: string;
  requestTimeoutMs?: number;
  groupContext?: "mentions_only" | "all_received";
}

export interface QqReplyPermit {
  readonly platform: "qq_official";
  readonly connectionId: string;
  readonly chatType: "private" | "group";
  readonly targetId: string;
  readonly messageId: string;
  readonly receivedAtMs: number;
  readonly expiresAtMs: number;
  readonly maxMessages: number;
}

export interface QqDeliveryReceipt {
  platform: "qq_official";
  connectionId: string;
  chatType: "private" | "group";
  targetId: string;
  messageId: string;
  referenceId?: string;
  acceptedText?: string;
  status: "accepted";
  timestampMs: number;
}

export type QqDeliveryFailureKind = "rejected" | "unknown";
export type QqDeliveryStage = "upload" | "message" | "stream";
export type QqMessageSubmissionStatus = "not_submitted" | "rejected" | "unknown";

// Do not include request URLs, payloads or response bodies: they may contain tokens.
export class QqDeliveryError extends Error {
  constructor(
    readonly kind: QqDeliveryFailureKind,
    readonly code: string,
    readonly httpStatus?: number,
    readonly stage: QqDeliveryStage = "message"
  ) {
    super(`QQ 官方接口${kind === "unknown" ? "结果未知" : "拒绝请求"} (${code})`);
    this.name = "QqDeliveryError";
  }
  get messageStatus(): QqMessageSubmissionStatus {
    return this.stage === "upload" ? "not_submitted" : this.kind;
  }
}

/** Preserve only sanitized classification across protocol stages, never raw errors or payloads. */
export function atQqDeliveryStage(error: unknown, stage: QqDeliveryStage): QqDeliveryError {
  if (error instanceof QqDeliveryError) return new QqDeliveryError(error.kind, error.code, error.httpStatus, stage);
  const cancelled = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
  return new QqDeliveryError(cancelled ? "rejected" : "unknown", cancelled ? "cancelled" : "operation_failed", undefined, stage);
}

export interface QqMediaInput {
  fileType: 1 | 2 | 3 | 4;
  url?: string;
  bytes?: Buffer;
  name?: string;
}

export interface QqMessageResponse {
  id: string;
  timestamp?: string;
  ext_info?: { ref_idx?: string };
}

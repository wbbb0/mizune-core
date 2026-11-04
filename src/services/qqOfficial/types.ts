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

// Do not include request URLs, payloads or response bodies: they may contain tokens.
export class QqDeliveryError extends Error {
  constructor(
    readonly kind: QqDeliveryFailureKind,
    readonly code: string,
    readonly httpStatus?: number
  ) {
    super(`QQ 官方接口${kind === "unknown" ? "结果未知" : "拒绝请求"} (${code})`);
    this.name = "QqDeliveryError";
  }
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

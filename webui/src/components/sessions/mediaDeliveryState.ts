import type { TranscriptItem } from "../../api/types.ts";

type OutboundMedia = Extract<TranscriptItem, { kind: "outbound_media_message" }>;

export interface MediaDeliveryState {
  label: string;
  detail: string;
  tone: "neutral" | "active" | "success" | "danger" | "warning";
}

/** A local preview is available before external delivery; it is never evidence of receipt. */
export function describeMediaDelivery(item: OutboundMedia): MediaDeliveryState {
  switch (item.deliveryStatus) {
    case "queued": return { label: "等待发送", detail: "媒体已加入发送队列，尚未提交平台。", tone: "neutral" };
    case "sending": return { label: "发送中", detail: "正在准备、上传或提交媒体。", tone: "active" };
    case "accepted": return item.delivery === "web"
      ? { label: "已记录", detail: "媒体已记录在此 Web 会话中。", tone: "success" }
      : { label: "平台已接受", detail: "平台已接受发送请求，客户端是否显示尚未确认。", tone: "success" };
    case "failed": return { label: "发送失败", detail: item.deliveryError?.message || "此次发送未成功，不会自动重发。", tone: "danger" };
    case "cancelled": return { label: "已取消", detail: "此次发送已取消。", tone: "neutral" };
    case "unknown": return { label: "结果未知", detail: "平台可能已接受请求；为避免重复消息，不会自动重发。", tone: "warning" };
  }
}

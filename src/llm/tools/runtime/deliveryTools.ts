import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { waitForMediaDelivery, mediaDeliveryResult, MAX_MEDIA_WAIT_MS } from "../core/mediaDeliveryStatus.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";

export const deliveryToolDescriptors: ToolDescriptor[] = [{
  definition: { type: "function", function: {
    name: "delivery_status",
    description: "查询当前会话一条媒体投递的状态。使用发送工具返回的delivery_id；可等待最多10秒。accepted仅表示平台接受，unknown禁止自动重发；等待超时不取消发送。",
    parameters: { type: "object", properties: {
      delivery_id: { type: "string" }, wait_ms: { type: "integer", minimum: 0, maximum: MAX_MEDIA_WAIT_MS }
    }, required: ["delivery_id"], additionalProperties: false }
  } }, resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
}];
export const deliveryToolHandlers: Record<string, ToolHandler> = {
  async delivery_status(_call, args, context) {
    const values = args as Record<string, unknown>;
    const id = values.delivery_id, waitMs = values.wait_ms ?? 0;
    if (typeof id !== "string" || !id || !Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > MAX_MEDIA_WAIT_MS) {
      return JSON.stringify({ ok: false, error: "需要delivery_id及0至10000的整数wait_ms。" });
    }
    const item = await waitForMediaDelivery(context.sessionManager, context.lastMessage.sessionId, id, Number(waitMs));
    return JSON.stringify(mediaDeliveryResult(item, id));
  }
};

import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { resolveForwardIdArg } from "../core/structuredIdResolver.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";

export const forwardToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "view_forward_record",
        description: "按 prompt 里的精确 forward_id 展开一条合并转发记录，返回节点、嵌套 forward ids 和 image ids。",
        parameters: {
          type: "object",
          properties: {
            forward_id: { type: "string" }
          },
          required: ["forward_id"],
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  }
];

export const forwardToolHandlers: Record<string, ToolHandler> = {
  async view_forward_record(toolCall, args, context) {
    const requestedForwardId = getStringArg(args, "forward_id");
    const forwardId = resolveForwardIdArg(requestedForwardId, toolCall.function.arguments, context);
    if (!forwardId) {
      return JSON.stringify({ error: "forward_id is required" });
    }

    try {
      const record = await context.forwardResolver.resolveForwardRecord(forwardId);
      return JSON.stringify({
        ok: true,
        forwardId: record.forwardId,
        fetchedAt: record.fetchedAt,
        nodeCount: record.nodes.length,
        nodes: record.nodes.map((node) => ({
          nodeIndex: node.nodeIndex,
          senderName: node.senderName,
          ...(node.userId ? { userId: node.userId } : {}),
          ...(node.time != null ? { time: node.time, timeText: formatTimestamp(node.time) } : {}),
          preview: node.preview,
          segments: node.segments.map((segment) => {
            if (segment.kind === "image") {
              return {
                kind: segment.kind,
                mediaKind: segment.mediaKind,
                imageId: segment.imageId,
                viewable: segment.viewable
              };
            }
            if (segment.kind === "forward") {
              return {
                kind: segment.kind,
                forwardId: segment.forwardId
              };
            }
            if (segment.kind === "text") {
              return {
                kind: segment.kind,
                text: segment.text
              };
            }
            return {
              kind: segment.kind,
              type: segment.type,
              summary: segment.summary
            };
          })
        }))
      });
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
};

function formatTimestamp(timestampSeconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestampSeconds * 1000));
}

import type { LlmContentPart, LlmToolExecutionResult } from "../../llmClient.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { mapWorkspaceAssetToFileView } from "../core/workspaceFileView.ts";

const MAX_MEDIA_VIEW_PER_CALL = 5;

export const imageToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "view_media",
        description: "按精确 media_ids 加载最多 5 个媒体资源，支持 workspace file、image/emoji/audio，供下一轮模型查看或读取其元数据。",
        parameters: {
          type: "object",
          properties: {
            media_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: MAX_MEDIA_VIEW_PER_CALL
            }
          },
          required: ["media_ids"],
          additionalProperties: false
        }
      }
    }
  }
];

export const imageToolHandlers: Record<string, ToolHandler> = {
  async view_media(_toolCall, args, context) {
    const mediaIds = getMediaIdsArg(args);
    if (mediaIds.length === 0) {
      return JSON.stringify({ error: "media_ids must contain at least one id" });
    }
    if (mediaIds.length > MAX_MEDIA_VIEW_PER_CALL) {
      return JSON.stringify({ error: `media_ids can contain at most ${MAX_MEDIA_VIEW_PER_CALL} ids` });
    }

    try {
      const assetIds = mediaIds.filter((item) => item.startsWith("asset_"));
      const audioIds = mediaIds.filter((item) => item.startsWith("aud_"));
      const unsupportedIds = mediaIds.filter((item) => !item.startsWith("aud_") && !item.startsWith("asset_"));
      if (unsupportedIds.length > 0) {
        return JSON.stringify({
          error: `Unsupported legacy media ids: ${unsupportedIds.join(", ")}`
        });
      }
      const transcriptionMap = await context.audioStore.getTranscriptionMap(audioIds);
      const audioAssets = await context.audioStore.getMany(audioIds);
      const workspaceAssets = await context.mediaWorkspace.getMany(assetIds);
      const assetCaptionMap = await context.mediaCaptionService.getCaptionMap(assetIds);
      const attachedWorkspaceImages = await Promise.all(
        workspaceAssets
          .filter((item) => item.kind === "image" || item.kind === "animated_image")
          .map(async (item) => {
            try {
              const prepared = await context.mediaVisionService.prepareAssetForModel(item.assetId);
              const assetCaption = (await context.mediaCaptionService.getCaptionMap([item.assetId])).get(item.assetId) ?? item.caption;
              return {
                mediaId: item.assetId,
                caption: assetCaption,
                inputUrl: prepared.inputUrl,
                animated: prepared.animated,
                durationMs: prepared.durationMs,
                sampledFrameCount: prepared.sampledFrameCount
              };
            } catch {
              return null;
            }
          })
      );
      const audioSummaries = audioAssets.map((item) => ({
        mediaId: item.id,
        kind: "audio" as const,
        source: item.source,
        transcription: transcriptionMap.get(item.id) ?? null,
        transcriptionStatus: item.transcriptionStatus,
        transcriptionError: item.transcriptionError
      }));

      const result: LlmToolExecutionResult = {
        content: JSON.stringify({
          ok: true,
          requestedCount: mediaIds.length,
          attachedCount: attachedWorkspaceImages.filter(Boolean).length,
          attached: attachedWorkspaceImages
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .map((item) => ({
              mediaId: item.mediaId,
              kind: "image",
              caption: item.caption,
              transport: "data_url",
              animated: item.animated,
              durationMs: item.durationMs,
              sampledFrameCount: item.sampledFrameCount
            })),
          workspace: workspaceAssets.map((item) => ({
            ...mapWorkspaceAssetToFileView(item),
            caption: assetCaptionMap.get(item.assetId) ?? item.caption
          })),
          audio: audioSummaries,
          unavailable: []
        }),
        supplementalMessages: attachedWorkspaceImages.some(Boolean)
          ? [{
              role: "user",
              content: buildImageMessage(
                [
                  ...attachedWorkspaceImages
                    .filter((item): item is NonNullable<typeof item> => Boolean(item))
                    .map((item) => ({
                      imageId: item.mediaId,
                      inputUrl: item.inputUrl,
                      kind: "image" as const,
                      animated: item.animated,
                      durationMs: item.durationMs,
                      sampledFrameCount: item.sampledFrameCount
                    }))
                ],
                new Map<string, string>([
                  ...attachedWorkspaceImages
                    .filter((item): item is NonNullable<typeof item> => Boolean(item))
                    .filter((item) => item.caption != null)
                    .map((item): [string, string] => [item.mediaId, item.caption ?? ""])
                ])
              )
            }]
          : []
      };
      return result;
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
};

function getMediaIdsArg(args: unknown): string[] {
  if (typeof args !== "object" || !args || !("media_ids" in args)) {
    return [];
  }
  const raw = (args as { media_ids?: unknown }).media_ids;
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of raw) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

function buildImageMessage(images: Array<{
  imageId: string;
  inputUrl: string;
  kind?: string;
  animated?: boolean;
  durationMs?: number | null;
  sampledFrameCount?: number | null;
}>, captionMap: ReadonlyMap<string, string>): LlmContentPart[] {
  return [
    {
      type: "text",
      text: [
        "以下视觉内容由 media_id 请求得到。",
        "把它们当作当前任务的系统提供视觉上下文。",
        ...images.map((item) => {
          const caption = captionMap.get(item.imageId);
          if (item.animated) {
            return `- ${item.imageId}${item.kind === "emoji" ? " (emoji)" : ""}${caption ? ` caption=${caption}` : ""} animated duration_ms=${item.durationMs ?? "未知"} sampled_frames=${item.sampledFrameCount ?? "未知"}`;
          }
          return `- ${item.imageId}${item.kind === "emoji" ? " (emoji)" : ""}${caption ? ` caption=${caption}` : ""}`;
        })
      ].join("\n")
    },
    ...images.map((item) => ({
      type: "image_url" as const,
      image_url: {
        url: item.inputUrl
      }
    }))
  ];
}

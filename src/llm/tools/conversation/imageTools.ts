import type { LlmContentPart, LlmToolExecutionResult } from "../../llmClient.ts";
import { resolveSendablePath } from "#services/workspace/sendablePath.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { mapWorkspaceFileToView } from "../core/workspaceFileView.ts";

const MAX_MEDIA_VIEW_PER_CALL = 5;

export const imageToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "chat_file_view_media",
        description: "加载已登记媒体供下一轮模型查看。",
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
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_view_media",
        description: "按路径加载本地图片供下一轮模型查看。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    }
  }
];

export const imageToolHandlers: Record<string, ToolHandler> = {
  async local_file_view_media(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    try {
      const resolved = resolveSendablePath(context.config, context.localFileService, path);
      const prepared = await context.mediaVisionService.prepareAbsolutePathForModel(resolved.absolutePath, resolved.sourceName);
      const result: LlmToolExecutionResult = {
        content: JSON.stringify({
          ok: true,
          path: resolved.sourcePath,
          sourceName: resolved.sourceName,
          kind: prepared.kind,
          transport: "data_url",
          animated: prepared.animated,
          durationMs: prepared.durationMs,
          sampledFrameCount: prepared.sampledFrameCount
        }),
        supplementalMessages: [{
          role: "user",
          content: buildImageMessage(
            [{ imageId: resolved.sourceName, inputUrl: prepared.inputUrl, kind: prepared.kind, animated: prepared.animated, durationMs: prepared.durationMs, sampledFrameCount: prepared.sampledFrameCount }],
            new Map()
          )
        }]
      };
      return result;
    } catch (error: unknown) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async chat_file_view_media(_toolCall, args, context) {
    const mediaIds = getMediaIdsArg(args);
    if (mediaIds.length === 0) {
      return JSON.stringify({ error: "media_ids must contain at least one id" });
    }
    if (mediaIds.length > MAX_MEDIA_VIEW_PER_CALL) {
      return JSON.stringify({ error: `media_ids can contain at most ${MAX_MEDIA_VIEW_PER_CALL} ids` });
    }

    try {
      const fileIds = mediaIds.filter((item) => item.startsWith("file_"));
      const audioIds = mediaIds.filter((item) => item.startsWith("aud_"));
      const unsupportedIds = mediaIds.filter((item) => !item.startsWith("aud_") && !item.startsWith("file_"));
      if (unsupportedIds.length > 0) {
        return JSON.stringify({
          error: `Unsupported legacy media ids: ${unsupportedIds.join(", ")}`
        });
      }
      const transcriptionMap = await context.audioStore.getTranscriptionMap(audioIds);
      const audioAssets = await context.audioStore.getMany(audioIds);
      const workspaceFiles = await context.chatFileStore.getMany(fileIds);
      const assetCaptionMap = await context.mediaCaptionService.getCaptionMap(fileIds);
      const attachedWorkspaceImages = await Promise.all(
        workspaceFiles
          .filter((item) => item.kind === "image" || item.kind === "animated_image")
          .map(async (item) => {
            try {
              const prepared = await context.mediaVisionService.prepareFileForModel(item.fileId);
              const assetCaption = (await context.mediaCaptionService.getCaptionMap([item.fileId])).get(item.fileId) ?? item.caption;
              return {
                mediaId: item.fileId,
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
          workspace: workspaceFiles.map((item) => ({
            ...mapWorkspaceFileToView(item),
            caption: assetCaptionMap.get(item.fileId) ?? item.caption
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

import type { LlmContentPart, LlmToolExecutionResult } from "../../llmClient.ts";
import type { AppConfig } from "#config/config.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { getVisionInputModelRefsForRole, hasVisionInputModelRef } from "#llm/shared/visionModelRouting.ts";
import { resolveSendablePath } from "#services/workspace/sendablePath.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { mapWorkspaceFileToView } from "../core/workspaceFileView.ts";
import { nextAction, type ToolNextAction } from "../core/toolNextActions.ts";
import {
  audioTranscriptionsFromDerivedObservations,
  DerivedObservationReader,
  imageCaptionMapFromDerivedObservations
} from "#llm/derivations/derivedObservationReader.ts";

const MAX_MEDIA_VIEW_PER_CALL = 5;

export const imageToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "chat_file_view_media",
        description: "加载已登记媒体供支持视觉输入的当前模型直接查看。",
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
    },
    isEnabled: isDirectMediaViewEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "chat_file_inspect_media",
        description: "调用图片精读模型，按问题读取已登记图片中的具体可见信息。",
        parameters: {
          type: "object",
          properties: {
            media_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: MAX_MEDIA_VIEW_PER_CALL
            },
            question: { type: "string" }
          },
          required: ["media_ids", "question"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isMediaInspectionEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_view_media",
        description: "按路径加载本地图片供支持视觉输入的当前模型直接查看。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isDirectMediaViewEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "local_file_inspect_media",
        description: "调用图片精读模型，按问题读取本地图片中的具体可见信息。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            question: { type: "string" }
          },
          required: ["path", "question"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isMediaInspectionEnabled
  }
];

function isDirectMediaViewEnabled(config: AppConfig, options?: { modelRef?: string | string[] }): boolean {
  const modelRef = options?.modelRef ?? getModelRefsForRole(config, "main_small");
  return hasVisionInputModelRef(config, modelRef);
}

function isMediaInspectionEnabled(config: AppConfig): boolean {
  return config.llm.imageInspector.enabled
    && getVisionInputModelRefsForRole(config, "image_inspector").modelRefs.length > 0;
}

export const imageToolHandlers: Record<string, ToolHandler> = {
  async local_file_inspect_media(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    const question = getStringArg(args, "question");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    if (!question) {
      return JSON.stringify({ error: "question is required" });
    }
    try {
      const resolved = resolveSendablePath(context.localFileService, path);
      const prepared = await context.mediaVisionService.prepareAbsolutePathForModel(resolved.absolutePath, resolved.sourceName);
      const inspection = await context.mediaInspectionService.inspectPreparedMedia({
        question,
        media: [{
          mediaId: resolved.sourceName,
          inputUrl: prepared.inputUrl,
          kind: prepared.kind,
          animated: prepared.animated,
          durationMs: prepared.durationMs,
          sampledFrameCount: prepared.sampledFrameCount
        }]
      });
      return JSON.stringify({
        ...inspection,
        path: resolved.sourcePath,
        sourceName: resolved.sourceName,
        kind: prepared.kind,
        animated: prepared.animated,
        durationMs: prepared.durationMs,
        sampledFrameCount: prepared.sampledFrameCount,
        inspectedCount: inspection.results.length
      });
    } catch (error: unknown) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async local_file_view_media(_toolCall, args, context) {
    const path = getStringArg(args, "path");
    if (!path) {
      return JSON.stringify({ error: "path is required" });
    }
    try {
      const resolved = resolveSendablePath(context.localFileService, path);
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
          sampledFrameCount: prepared.sampledFrameCount,
          next_actions: [
            nextAction("local_file_send_to_chat", "把当前本地媒体文件发送到聊天", { path: resolved.sourcePath })
          ]
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

  async chat_file_inspect_media(_toolCall, args, context) {
    const mediaIds = getMediaIdsArg(args);
    const question = getStringArg(args, "question");
    if (mediaIds.length === 0) {
      return JSON.stringify({ error: "media_ids must contain at least one id" });
    }
    if (mediaIds.length > MAX_MEDIA_VIEW_PER_CALL) {
      return JSON.stringify({ error: `media_ids can contain at most ${MAX_MEDIA_VIEW_PER_CALL} ids` });
    }
    if (!question) {
      return JSON.stringify({ error: "question is required" });
    }

    try {
      const fileIds = mediaIds.filter((item) => item.startsWith("file_"));
      const unsupportedIds = mediaIds.filter((item) => !item.startsWith("file_"));
      if (unsupportedIds.length > 0) {
        return JSON.stringify({
          error: `Unsupported legacy media ids: ${unsupportedIds.join(", ")}`
        });
      }

      const workspaceFiles = await context.chatFileStore.getMany(fileIds);
      const preparedMedia = (await Promise.all(
        workspaceFiles
          .filter((item) => item.kind === "image" || item.kind === "animated_image")
          .map(async (item) => {
            try {
              const prepared = await context.mediaVisionService.prepareFileForModel(item.fileId);
              return {
                mediaId: item.fileId,
                inputUrl: prepared.inputUrl,
                kind: prepared.kind,
                animated: prepared.animated,
                durationMs: prepared.durationMs,
                sampledFrameCount: prepared.sampledFrameCount
              };
            } catch {
              return null;
            }
          })
      )).filter((item): item is NonNullable<typeof item> => Boolean(item));
      const inspection = await context.mediaInspectionService.inspectPreparedMedia({
        question,
        media: preparedMedia
      });

      return JSON.stringify({
        ...inspection,
        requestedCount: mediaIds.length,
        inspectedCount: inspection.results.length,
        workspace: workspaceFiles.map((item) => mapWorkspaceFileToView(item)),
        unavailable: fileIds.filter((fileId) => !preparedMedia.some((item) => item.mediaId === fileId))
      });
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
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
      const [audioAssets, workspaceFiles, derivedObservations] = await Promise.all([
        context.audioStore.getMany(audioIds),
        context.chatFileStore.getMany(fileIds),
        new DerivedObservationReader({
          audioStore: context.audioStore,
          chatFileStore: context.chatFileStore
        }).read({ audioIds, chatFileIds: fileIds })
      ]);
      const assetCaptionMap = imageCaptionMapFromDerivedObservations(derivedObservations);
      const transcriptionMap = new Map(
        audioTranscriptionsFromDerivedObservations(derivedObservations, audioIds)
          .filter((item) => item.status === "ready" && typeof item.text === "string")
          .map((item) => [item.audioId, item.text as string])
      );
      const attachedWorkspaceImages = await Promise.all(
        workspaceFiles
          .filter((item) => item.kind === "image" || item.kind === "animated_image")
          .map(async (item) => {
            try {
              const prepared = await context.mediaVisionService.prepareFileForModel(item.fileId);
              const assetCaption = assetCaptionMap.get(item.fileId) ?? item.caption;
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
          unavailable: [],
          next_actions: viewedMediaNextActions(workspaceFiles)
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

function viewedMediaNextActions(files: Array<{ fileId: string; fileRef: string }>): ToolNextAction[] {
  return files.slice(0, MAX_MEDIA_VIEW_PER_CALL).map((file) =>
    nextAction("chat_file_send_to_chat", "发送已查看的媒体文件到当前聊天", { file_ref: file.fileRef || file.fileId })
  );
}

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

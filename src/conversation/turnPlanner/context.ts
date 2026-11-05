import type { Logger } from "pino";
import { annotateHistoryMessagesWithCaptions, collectReferencedImageIds } from "#images/imagePromptContext.ts";
import { collectVisualAttachmentFileIds, isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { PreparedTurnPlannerInput, TurnPlannerInput } from "./types.ts";
import { analyzeTurnPlannerBatch } from "../turnPlannerBatchAnalysis.ts";

type TurnPlannerMediaCaptionKind = "image" | "emoji";
type TurnPlannerMediaCaption = PreparedTurnPlannerInput["mediaCaptions"][number];

export interface TurnPlannerMediaServices {
  chatFileStore: Pick<ChatFileStore, "getMany">;
  mediaVisionService: Pick<MediaVisionService, "prepareFilesForModel">;
  mediaCaptionService?: Pick<MediaCaptionService, "ensureReady">;
}

export async function prepareTurnPlannerContext(input: TurnPlannerInput, supportsVision: boolean, services: TurnPlannerMediaServices, logger: Logger): Promise<PreparedTurnPlannerInput> {
  input.abortSignal?.throwIfAborted();
  const captionContext = await prepareCaptionContext(input, input.recentMessages, supportsVision, services.mediaCaptionService, logger);
  const mediaRefs = collectBatchMediaRefs(input.batchMessages);
  const mediaKinds = new Map(mediaRefs.map(item => [item.imageId, item.kind]));
  const visualImageIds = supportsVision
    ? uniqueIds([...mediaRefs.map(item => item.imageId), ...collectReferencedImageIds(input.recentMessages)]).slice(0, 5)
    : [];
  let visualInputs: PreparedTurnPlannerInput["visualInputs"] = [];
  if (visualImageIds.length > 0) {
    try {
      const files = await services.chatFileStore.getMany(visualImageIds);
      input.abortSignal?.throwIfAborted();
      const existingIds = new Set(files.map(item => item.fileId));
      visualInputs = (await services.mediaVisionService.prepareFilesForModel(visualImageIds.filter(id => existingIds.has(id))))
        .filter(item => existingIds.has(item.fileId))
        .map(item => ({ imageId: item.fileId, kind: mediaKinds.get(item.fileId) ?? "image", inputUrl: item.inputUrl, animated: item.animated,
          durationMs: item.durationMs, sampledFrameCount: item.sampledFrameCount }));
    } catch (error) {
      input.abortSignal?.throwIfAborted();
      logger.warn({ sessionId: input.sessionId, error: error instanceof Error ? error.message : String(error) }, "turn_planner_visual_prepare_failed");
    }
  }
  input.abortSignal?.throwIfAborted();
  return { ...input, ...captionContext, availableToolsets: input.availableToolsets ?? [], batchAnalysis: analyzeTurnPlannerBatch(input.batchMessages), visualInputs };
}

async function prepareCaptionContext(
  input: TurnPlannerInput,
  recentMessages: TurnPlannerInput["recentMessages"],
  supportsVision: boolean,
  mediaCaptionService: Pick<MediaCaptionService, "ensureReady"> | undefined,
  logger: Logger
): Promise<{
  recentMessages: TurnPlannerInput["recentMessages"];
  mediaCaptions: TurnPlannerMediaCaption[];
}> {
  if (supportsVision || !mediaCaptionService) {
    return { recentMessages, mediaCaptions: [] };
  }

  const historyImageIds = collectReferencedImageIds(recentMessages);
  const batchRefs = collectBatchMediaRefs(input.batchMessages);
  const imageIds = uniqueIds([...historyImageIds, ...batchRefs.map((item) => item.imageId)]);
  if (imageIds.length === 0) {
    return { recentMessages, mediaCaptions: [] };
  }

  try {
    const captions = await mediaCaptionService.ensureReady(imageIds, {
      reason: "turn_planner_caption_context",
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    return {
      recentMessages: annotateHistoryMessagesWithCaptions(recentMessages, captions, { includeIds: true }),
      mediaCaptions: batchRefs
        .map((item) => {
          const caption = captions.get(item.imageId);
          return caption ? { ...item, caption } : null;
        })
        .filter((item): item is TurnPlannerMediaCaption => item != null)
    };
  } catch (error: unknown) {
    input.abortSignal?.throwIfAborted();
    logger.warn(
      {
        sessionId: input.sessionId,
        imageIds,
        error: error instanceof Error ? error.message : String(error)
      },
      "turn_planner_image_caption_context_failed"
    );
    return { recentMessages, mediaCaptions: [] };
  }
}

function collectBatchMediaRefs(messages: TurnPlannerInput["batchMessages"]): Array<{
  imageId: string;
  kind: TurnPlannerMediaCaptionKind;
}> {
  const refs: Array<{ imageId: string; kind: TurnPlannerMediaCaptionKind }> = [];
  const seen = new Set<string>();
  const add = (imageId: string, kind: TurnPlannerMediaCaptionKind): void => {
    const normalized = String(imageId ?? "").trim();
    if (!normalized || isPendingChatAttachmentId(normalized) || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    refs.push({ imageId: normalized, kind });
  };

  for (const message of messages) {
    for (const imageId of message.imageIds ?? []) {
      add(imageId, "image");
    }
    for (const emojiId of message.emojiIds ?? []) {
      add(emojiId, "emoji");
    }
    for (const imageId of collectVisualAttachmentFileIds(message.attachments, "image")) {
      add(imageId, "image");
    }
    for (const emojiId of collectVisualAttachmentFileIds(message.attachments, "emoji")) {
      add(emojiId, "emoji");
    }
    for (const part of message.contentParts ?? []) {
      if ((part.kind === "image" || part.kind === "emoji") && part.fileId) {
        add(part.fileId, part.kind);
      }
    }
  }

  return refs;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

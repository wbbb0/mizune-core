export interface ReplyGateBatchAnalysisMessage {
  text?: string;
  audioSources?: string[];
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: Array<{
    fileId: string;
    kind: string;
    semanticKind?: "image" | "emoji";
  }>;
  forwardIds?: string[];
  replyMessageId?: string | null;
  mentionUserIds?: string[];
  mentionedAll?: boolean;
  mentionedSelf?: boolean;
}

export interface ReplyGateBatchAnalysis {
  messageCount: number;
  textMessageCount: number;
  audioMessageCount: number;
  imageMessageCount: number;
  emojiMessageCount: number;
  forwardMessageCount: number;
  replyReferenceCount: number;
  mentionMessageCount: number;
  hasText: boolean;
  hasAudio: boolean;
  hasImages: boolean;
  hasEmoji: boolean;
  hasForward: boolean;
  hasReplyReference: boolean;
  hasMentionSignal: boolean;
  hasStructuredResolvableContent: boolean;
  summaryTags: string[];
}

function hasMentionSignal(message: ReplyGateBatchAnalysisMessage): boolean {
  return Boolean(message.mentionedAll)
    || Boolean(message.mentionedSelf)
    || (message.mentionUserIds?.length ?? 0) > 0;
}

export function analyzeReplyGateBatch(messages: ReplyGateBatchAnalysisMessage[]): ReplyGateBatchAnalysis {
  const analysis: ReplyGateBatchAnalysis = {
    messageCount: messages.length,
    textMessageCount: 0,
    audioMessageCount: 0,
    imageMessageCount: 0,
    emojiMessageCount: 0,
    forwardMessageCount: 0,
    replyReferenceCount: 0,
    mentionMessageCount: 0,
    hasText: false,
    hasAudio: false,
    hasImages: false,
    hasEmoji: false,
    hasForward: false,
    hasReplyReference: false,
    hasMentionSignal: false,
    hasStructuredResolvableContent: false,
    summaryTags: []
  };

  for (const message of messages) {
    const hasText = Boolean(message.text?.trim());
    const hasAudio = (message.audioSources?.length ?? 0) > 0;
    const hasImages = (message.attachments?.some((item) => (
      (item.kind === "image" || item.kind === "animated_image") && item.semanticKind !== "emoji"
    )) ?? false) || (message.imageIds?.length ?? 0) > 0;
    const hasEmoji = (message.attachments?.some((item) => item.semanticKind === "emoji") ?? false)
      || (message.emojiIds?.length ?? 0) > 0;
    const hasForward = (message.forwardIds?.length ?? 0) > 0;
    const hasReplyReference = Boolean(message.replyMessageId);
    const hasMention = hasMentionSignal(message);

    if (hasText) {
      analysis.textMessageCount += 1;
      analysis.hasText = true;
    }
    if (hasAudio) {
      analysis.audioMessageCount += 1;
      analysis.hasAudio = true;
    }
    if (hasImages) {
      analysis.imageMessageCount += 1;
      analysis.hasImages = true;
    }
    if (hasEmoji) {
      analysis.emojiMessageCount += 1;
      analysis.hasEmoji = true;
    }
    if (hasForward) {
      analysis.forwardMessageCount += 1;
      analysis.hasForward = true;
    }
    if (hasReplyReference) {
      analysis.replyReferenceCount += 1;
      analysis.hasReplyReference = true;
    }
    if (hasMention) {
      analysis.mentionMessageCount += 1;
      analysis.hasMentionSignal = true;
    }
  }

  analysis.hasStructuredResolvableContent = analysis.hasAudio
    || analysis.hasImages
    || analysis.hasEmoji
    || analysis.hasForward
    || analysis.hasReplyReference;

  if (analysis.hasAudio) {
    analysis.summaryTags.push("audio");
  }
  if (analysis.hasImages) {
    analysis.summaryTags.push("image");
  }
  if (analysis.hasEmoji) {
    analysis.summaryTags.push("emoji");
  }
  if (analysis.hasForward) {
    analysis.summaryTags.push("forward");
  }
  if (analysis.hasReplyReference) {
    analysis.summaryTags.push("reply_ref");
  }
  if (analysis.hasMentionSignal) {
    analysis.summaryTags.push("mention");
  }
  if (analysis.hasText) {
    analysis.summaryTags.push("text");
  }

  return analysis;
}

import { splitReadySegments } from "#llm/shared/streamSplitter.ts";
import type { GenerationDraftOverlaySink, GenerationDraftStateSink } from "./generationOutputContracts.ts";

export interface GenerationSegmentCommittedSink {
  enqueueChunk: (
    chunk: string,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ) => Promise<boolean | void>;
  flushBufferedOutput: (
    summary: string,
    streamBuffer: string,
    streamResponse: boolean | undefined
  ) => Promise<string>;
}

export function createGenerationSegmentCoordinator(input: {
  disableStreamingSplit: boolean;
  committedSink: GenerationSegmentCommittedSink;
  draftOverlaySink?: GenerationDraftOverlaySink;
  draftStateSink?: GenerationDraftStateSink;
}) {
  let streamBuffer = "";
  let committedText = "";
  let providerReplayCursor = 0;

  const appendCommittedText = (
    chunk: string,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ) => {
    if (!chunk.trim()) {
      return;
    }
    committedText = committedText && options?.joinWithDoubleNewline === true
      ? `${committedText}\n\n${chunk}`
      : `${committedText}${chunk}`;
  };

  const commitChunk = async (
    chunk: string,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ): Promise<boolean | void> => {
    const committed = await input.committedSink.enqueueChunk(chunk, options);
    if (committed !== false) {
      appendCommittedText(chunk, options);
    }
    return committed;
  };

  const clearDraftOrReplace = async () => {
    if (!streamBuffer.trim()) {
      await input.draftStateSink?.clearDraftText();
    } else {
      await input.draftStateSink?.replaceDraftText(streamBuffer);
    }
  };

  const flushBufferedChunk = async (): Promise<void> => {
    if (!streamBuffer.trim()) {
      return;
    }
    const currentResponseCommittedText = committedText.slice(providerReplayCursor);
    const chunk = resolveUncommittedTextTail(streamBuffer, currentResponseCommittedText)
      .replace(/^(?:[ \t]*\r?\n){2,}/, "");
    if (!chunk.trim()) {
      streamBuffer = "";
      await input.draftStateSink?.clearDraftText();
      return;
    }
    const committed = await commitChunk(chunk);
    if (committed !== false) {
      streamBuffer = "";
      await input.draftStateSink?.clearDraftText();
    }
  };

  const resolveUncommittedTextTail = (text: string, committedPrefix: string): string => {
    if (!text.trim() || !committedPrefix.trim()) {
      return text;
    }
    if (text.startsWith(committedPrefix)) {
      return text.slice(committedPrefix.length);
    }
    const trimmedText = text.trim();
    const trimmedCommitted = committedPrefix.trim();
    if (trimmedText === trimmedCommitted) {
      return "";
    }
    if (trimmedText.startsWith(trimmedCommitted)) {
      return trimmedText.slice(trimmedCommitted.length);
    }
    return text;
  };

  const resolveUncommittedSummaryTail = (summary: string): string => {
    const currentResponseCommittedText = committedText.slice(providerReplayCursor);
    if (!currentResponseCommittedText.trim()) {
      return summary;
    }
    if (!summary.trim()) {
      return "";
    }
    return resolveUncommittedTextTail(summary, currentResponseCommittedText) || streamBuffer;
  };

  const flushSummaryTail = async (summary: string): Promise<void> => {
    const tail = resolveUncommittedSummaryTail(summary);
    const text = tail.replace(/^(?:[ \t]*\r?\n){2,}/, "");
    if (!text.trim()) {
      streamBuffer = "";
      await input.draftStateSink?.clearDraftText();
      return;
    }
    const joinWithDoubleNewline = text !== tail;
    const committed = await commitChunk(text, { joinWithDoubleNewline });
    if (committed !== false) {
      streamBuffer = "";
      await input.draftStateSink?.clearDraftText();
    } else {
      streamBuffer = text;
      await input.draftStateSink?.replaceDraftText(streamBuffer);
    }
  };

  return {
    async onTextDelta(delta: string): Promise<void> {
      streamBuffer += delta;
      await input.draftOverlaySink?.appendDelta(delta);
      await input.draftStateSink?.replaceDraftText(streamBuffer);
      if (input.disableStreamingSplit) {
        return;
      }
      const split = splitReadySegments(streamBuffer);
      const originalBuffer = streamBuffer;
      let committedEnd = 0;
      for (let chunkIndex = 0; chunkIndex < split.ready.length; chunkIndex += 1) {
        const chunk = split.ready[chunkIndex]!;
        const committed = await commitChunk(chunk.text, {
          joinWithDoubleNewline: chunk.joinWithDoubleNewline
        });
        if (committed !== false) {
          committedEnd = split.readyConsumedEnds[chunkIndex] ?? committedEnd;
          await input.draftStateSink?.replaceDraftText(originalBuffer.slice(committedEnd));
          await input.draftOverlaySink?.markCommitted();
        } else {
          break;
        }
      }
      streamBuffer = originalBuffer.slice(committedEnd);
    },

    flushBufferedChunk,

    async flushSummary(summary: string, streamResponse: boolean | undefined): Promise<void> {
      if (streamResponse !== false && committedText.trim()) {
        await flushSummaryTail(summary);
        return;
      }
      streamBuffer = await input.committedSink.flushBufferedOutput(summary, streamBuffer, streamResponse);
      await clearDraftOrReplace();
    },

    getCommittedText(): string {
      return committedText;
    },

    resolveProviderAssistantText(providerText: string): string {
      const committedSinceLastReplay = committedText.slice(providerReplayCursor);
      if (committedSinceLastReplay.trim()) {
        providerReplayCursor = committedText.length;
        return committedSinceLastReplay;
      }
      return providerText;
    }
  };
}

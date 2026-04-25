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
        const committed = await input.committedSink.enqueueChunk(chunk.text, {
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

    async flushBufferedChunk(): Promise<void> {
      if (!streamBuffer.trim()) {
        return;
      }
      const committed = await input.committedSink.enqueueChunk(streamBuffer);
      if (committed !== false) {
        streamBuffer = "";
        await input.draftStateSink?.clearDraftText();
      }
    },

    async flushSummary(summary: string, streamResponse: boolean | undefined): Promise<void> {
      streamBuffer = await input.committedSink.flushBufferedOutput(summary, streamBuffer, streamResponse);
      if (!streamBuffer.trim()) {
        await input.draftStateSink?.clearDraftText();
      } else {
        await input.draftStateSink?.replaceDraftText(streamBuffer);
      }
    }
  };
}

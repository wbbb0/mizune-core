import { splitReadySegments } from "#llm/shared/streamSplitter.ts";
import type { GenerationDraftOverlaySink } from "./generationOutputContracts.ts";

export interface GenerationSegmentCommittedSink {
  enqueueChunk: (
    chunk: string,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ) => Promise<void>;
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
}) {
  let streamBuffer = "";

  return {
    async onTextDelta(delta: string): Promise<void> {
      streamBuffer += delta;
      await input.draftOverlaySink?.appendDelta(delta);
      if (input.disableStreamingSplit) {
        return;
      }
      const split = splitReadySegments(streamBuffer);
      streamBuffer = split.rest;
      for (const chunk of split.ready) {
        await input.committedSink.enqueueChunk(chunk.text, {
          joinWithDoubleNewline: chunk.joinWithDoubleNewline
        });
        await input.draftOverlaySink?.markCommitted();
      }
    },

    async flushBufferedChunk(): Promise<void> {
      if (!streamBuffer.trim()) {
        return;
      }
      await input.committedSink.enqueueChunk(streamBuffer);
      streamBuffer = "";
    },

    async flushSummary(summary: string, streamResponse: boolean | undefined): Promise<void> {
      streamBuffer = await input.committedSink.flushBufferedOutput(summary, streamBuffer, streamResponse);
    }
  };
}

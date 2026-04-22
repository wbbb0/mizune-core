export interface GenerationCommittedTextSink {
  commitText: (text: string) => Promise<void> | void;
}

export type GenerationDeliveryPacing = "humanized" | "immediate";

export interface GenerationDraftOverlaySink {
  appendDelta: (delta: string) => Promise<void> | void;
  markCommitted: () => Promise<void> | void;
  complete: () => Promise<void> | void;
  fail: (message: string) => Promise<void> | void;
}

import { SerialExecutor } from "#utils/serialExecutor.ts";
import type { AssetReference } from "./sessionAssetReferences.ts";

/** One instance per application: durable owner writes and GC share this boundary. */
export class AssetReferenceCoordinator {
  private readonly executor = new SerialExecutor();
  private readonly leases = new Map<symbol, readonly AssetReference[]>();

  constructor(private readonly retainChatFiles?: (fileIds: Iterable<string>) => () => void) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return this.executor.run(task);
  }

  /** Acquire inside run(), then release after an operation that may itself persist a session. */
  retain(references: readonly AssetReference[]): () => void {
    const id = Symbol("asset-reference-lease");
    const releaseChatFiles = this.retainChatFiles?.(references
      .filter(reference => reference.assetKind === "chat_file")
      .map(reference => reference.assetId));
    this.leases.set(id, this.retainChatFiles
      ? references.filter(reference => reference.assetKind !== "chat_file")
      : references);
    return () => {
      releaseChatFiles?.();
      this.leases.delete(id);
    };
  }

  *retainedReferences(): IterableIterator<AssetReference> {
    for (const references of this.leases.values()) yield* references;
  }
}

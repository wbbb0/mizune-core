import type { AppConfig } from "#config/config.ts";
import { toCanonicalModelRef } from "./modelTarget.ts";

export function getEmbeddingModelRefs(config: AppConfig): string[] {
  const target = config.context.embedding.model;
  return target ? [toCanonicalModelRef(target)] : [];
}

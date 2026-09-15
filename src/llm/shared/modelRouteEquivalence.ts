import { isDeepStrictEqual } from "node:util";
import type { AppConfig } from "#config/config.ts";
import { getModelRefsForRole } from "./modelRouting.ts";

// Alias names do not affect requests. Candidate ordering and every profile setting do.
export function areMainModelRoutesEquivalent(config: AppConfig): boolean {
  const small = getModelRefsForRole(config, "main_small");
  const large = getModelRefsForRole(config, "main_large");
  return small.length > 0 && small.length === large.length && small.every((ref, index) => {
    const left = config.llm.models[ref];
    const right = config.llm.models[large[index]!];
    return left != null && right != null && isDeepStrictEqual(left, right);
  });
}

import { isDeepStrictEqual } from "node:util";
import type { AppConfig } from "#config/config.ts";
import { getModelRefsForRole } from "./modelRouting.ts";

// Alias names do not affect requests. Candidate ordering and every profile setting do.
export function areMainModelRoutesEquivalent(config: AppConfig): boolean {
  const small = getModelRefsForRole(config, "main_small");
  const large = getModelRefsForRole(config, "main_large");
  return areModelRoutesEquivalent(config, small, large);
}

export function areModelProfilesEquivalent(config: AppConfig, leftRef: string, rightRef: string): boolean {
  const left = config.llm.models[leftRef];
  const right = config.llm.models[rightRef];
  return left != null && right != null && isDeepStrictEqual(left, right);
}

export function areModelRoutesEquivalent(config: AppConfig, left: readonly string[], right: readonly string[]): boolean {
  return left.length > 0 && left.length === right.length
    && left.every((ref, index) => areModelProfilesEquivalent(config, ref, right[index]!));
}

export function modelRefMatchesRoute(config: AppConfig, ref: string, route: readonly string[]): boolean {
  return route.some(candidate => areModelProfilesEquivalent(config, ref, candidate));
}

/** Explain configured role overlap without guessing model capability from names. */
export function getMainModelRouteWarnings(config: AppConfig): string[] {
  const small = getModelRefsForRole(config, "main_small");
  const large = getModelRefsForRole(config, "main_large");
  if (areModelRoutesEquivalent(config, small, large)) {
    return ["大小主模型路由配置等价：将按单档模型运行，不会产生实际能力升级。"];
  }
  if (large.some(ref => modelRefMatchesRoute(config, ref, small))) {
    return ["完整模型候选链包含与轻量模型相同的配置：使用这些候选时不代表实际能力提升。"];
  }
  return [];
}

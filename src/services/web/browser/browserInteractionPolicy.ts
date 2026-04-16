import type {
  BrowserActionTarget,
  BrowserSnapshot,
  InteractWithPageInput
} from "./types.ts";
import { validateHttpUrl } from "./contentExtraction.ts";

export function validateInteractionInput(input: InteractWithPageInput): string | null {
  const hasCoordinate = hasBrowserCoordinate(input.coordinate);
  const hasElementTarget = input.targetId !== undefined || hasSemanticTarget(input.target);
  const hasTarget = hasElementTarget || hasCoordinate;
  const disallowTarget = input.action === "wait"
    || input.action === "scroll_down"
    || input.action === "scroll_up"
    || input.action === "go_back"
    || input.action === "go_forward"
    || input.action === "reload";

  if (disallowTarget && hasTarget) {
    return `action ${input.action} does not accept target_id, target or coordinate`;
  }

  if (hasCoordinate && hasElementTarget) {
    return "coordinate cannot be combined with target_id or target";
  }

  if (hasCoordinate && input.action !== "click" && input.action !== "hover") {
    return `action ${input.action} does not accept coordinate`;
  }

  if (input.action === "press") {
    if (!String(input.key ?? "").trim()) {
      return "press action requires non-empty key";
    }
    return null;
  }

  if (input.action === "type") {
    if (!hasElementTarget) {
      return "type action requires target_id or target";
    }
    if (input.text === undefined) {
      return "type action requires text";
    }
    return null;
  }

  if (input.action === "upload") {
    if (!hasElementTarget) {
      return "upload action requires target_id or target";
    }
    if (!Array.isArray(input.filePaths) || input.filePaths.length === 0) {
      return "upload action requires non-empty file_paths";
    }
    return null;
  }

  if (input.action === "select") {
    if (!hasElementTarget) {
      return "select action requires target_id or target";
    }
    if (!String(input.value ?? input.text ?? "").trim()) {
      return "select action requires value";
    }
    return null;
  }

  if (input.action === "click"
    || input.action === "hover"
    || input.action === "check"
    || input.action === "uncheck"
    || input.action === "submit") {
    return hasTarget ? null : `action ${input.action} requires target_id or target`;
  }

  return null;
}

export function hasBrowserCoordinate(
  coordinate: InteractWithPageInput["coordinate"] | undefined
): boolean {
  return Number.isFinite(coordinate?.x) && Number.isFinite(coordinate?.y);
}

export function resolveInteractionTarget(
  elements: readonly BrowserSnapshot["elements"][number][],
  input: InteractWithPageInput
): {
  ok: true;
  targetId: number | undefined;
  resolvedTarget: BrowserSnapshot["elements"][number] | null;
  candidateCount: number;
  candidates: BrowserSnapshot["elements"];
} | {
  ok: false;
  candidateCount: number;
  candidates: BrowserSnapshot["elements"];
  disambiguationRequired: boolean;
  message: string;
} {
  if (input.targetId !== undefined) {
    const resolvedTarget = elements.find((item) => item.id === input.targetId) ?? null;
    if (!resolvedTarget) {
      return {
        ok: false,
        candidateCount: 0,
        candidates: [],
        disambiguationRequired: false,
        message: `未找到 target_id=${input.targetId} 对应的元素，请先重新 inspect_page。`
      };
    }
    if (resolvedTarget.disabled) {
      return {
        ok: false,
        candidateCount: 1,
        candidates: [resolvedTarget],
        disambiguationRequired: false,
        message: `目标元素 #${resolvedTarget.id} 当前不可用（disabled）。`
      };
    }
    return {
      ok: true,
      targetId: resolvedTarget.id,
      resolvedTarget,
      candidateCount: 1,
      candidates: [resolvedTarget]
    };
  }

  if (hasBrowserCoordinate(input.coordinate)) {
    return {
      ok: true,
      targetId: undefined,
      resolvedTarget: null,
      candidateCount: 0,
      candidates: []
    };
  }

  if (!hasSemanticTarget(input.target)) {
    return {
      ok: true,
      targetId: undefined,
      resolvedTarget: null,
      candidateCount: 0,
      candidates: []
    };
  }

  const matches = elements.filter((item) => matchesSemanticTarget(item, input.target!));
  const visibleMatches = matches.filter((item) => !item.disabled && item.visibility === "visible");
  const candidates = (visibleMatches.length > 0 ? visibleMatches : matches).slice(0, 5);
  if (visibleMatches.length === 0) {
    return {
      ok: false,
      candidateCount: matches.length,
      candidates,
      disambiguationRequired: false,
      message: "未找到与目标描述匹配的可操作元素。"
    };
  }

  const requestedIndex = input.target?.index;
  if (requestedIndex !== undefined) {
    const indexed = visibleMatches[requestedIndex - 1];
    if (!indexed) {
      return {
        ok: false,
        candidateCount: visibleMatches.length,
        candidates,
        disambiguationRequired: false,
        message: `目标描述只匹配到 ${visibleMatches.length} 个候选，index=${requestedIndex} 超出范围。`
      };
    }
    return {
      ok: true,
      targetId: indexed.id,
      resolvedTarget: indexed,
      candidateCount: visibleMatches.length,
      candidates
    };
  }

  if (visibleMatches.length > 1) {
    return {
      ok: false,
      candidateCount: visibleMatches.length,
      candidates,
      disambiguationRequired: true,
      message: `目标描述匹配到 ${visibleMatches.length} 个候选，请改用 target.index 或 target_id。`
    };
  }

  const resolvedTarget = visibleMatches[0] ?? null;
  return {
    ok: true,
    targetId: resolvedTarget?.id,
    resolvedTarget,
    candidateCount: visibleMatches.length,
    candidates
  };
}

export function buildInteractionSuccessMessage(
  action: InteractWithPageInput["action"],
  target: BrowserSnapshot["elements"][number] | null
): string {
  if (!target) {
    return `已执行页面动作：${action}。`;
  }
  const label = target.name || target.text || target.locator_hint || `#${target.id}`;
  return `已对元素 ${label} 执行 ${action}。`;
}

export function extractDownloadSourceUrl(element: BrowserSnapshot["elements"][number]): string | null {
  const candidates = [
    element.href,
    element.media_url,
    element.poster_url,
    ...element.source_urls
  ];
  for (const candidate of candidates) {
    const resolved = validateHttpUrl(String(candidate ?? "").trim());
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function hasSemanticTarget(target: BrowserActionTarget | undefined): boolean {
  if (!target) {
    return false;
  }
  return Boolean(
    target.role
    || target.name
    || target.text
    || target.tag
    || target.type
    || target.hrefContains
    || target.index !== undefined
  );
}

function matchesSemanticTarget(element: BrowserSnapshot["elements"][number], target: BrowserActionTarget): boolean {
  if (target.role && !stringIncludes(element.role, target.role)) {
    return false;
  }
  if (target.name && !stringIncludes(element.name, target.name)) {
    return false;
  }
  if (target.text && !stringIncludes(element.text, target.text)) {
    return false;
  }
  if (target.tag && !stringIncludes(element.tag, target.tag, { exact: true })) {
    return false;
  }
  if (target.type && !stringIncludes(element.type, target.type, { exact: true })) {
    return false;
  }
  if (target.hrefContains && !stringIncludes(element.href, target.hrefContains)) {
    return false;
  }
  return true;
}

function stringIncludes(
  value: string | null | undefined,
  expected: string,
  options?: { exact?: boolean }
): boolean {
  const normalizedValue = String(value ?? "").trim().toLowerCase();
  const normalizedExpected = String(expected ?? "").trim().toLowerCase();
  if (!normalizedExpected) {
    return true;
  }
  return options?.exact ? normalizedValue === normalizedExpected : normalizedValue.includes(normalizedExpected);
}

import type { AppConfig } from "#config/config.ts";
import type { ModerationResult, ModerationSubjectKind } from "./contentSafetyTypes.ts";

const SUBJECT_LABELS: Record<ModerationSubjectKind, string> = {
  text: "内容",
  image: "图片",
  emoji: "表情",
  audio_transcript: "音频",
  file: "文件",
  local_media: "媒体"
};

export function buildContentSafetyMarker(input: {
  subjectKind: ModerationSubjectKind;
  result: ModerationResult;
  subjectRef?: string | undefined;
  markerConfig: AppConfig["contentSafety"]["marker"];
}): string {
  const parts = [`${SUBJECT_LABELS[input.subjectKind]}已屏蔽：${input.result.reason || "疑似违规"}`];
  if (input.markerConfig.includeSubjectRef && input.subjectRef) {
    parts.push(input.subjectRef);
  }
  if (input.markerConfig.includeLabels && input.result.labels.length > 0) {
    parts.push(`标签=${input.result.labels.map((item) => item.label).join(",")}`);
  }
  if (input.markerConfig.includeConfidence) {
    const confidence = input.result.labels
      .map((item) => item.confidence)
      .filter((item): item is number => typeof item === "number");
    if (confidence.length > 0) {
      parts.push(`置信度=${Math.max(...confidence)}`);
    }
  }
  if (input.markerConfig.includeProvider) {
    parts.push(`来源=${input.result.providerId}`);
  }
  return `[${parts.join("；")}]`;
}


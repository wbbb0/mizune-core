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
  const subjectLabel = SUBJECT_LABELS[input.subjectKind];
  const reason = input.result.reason || "疑似违规";
  const parts = [isVisualSubject(input.subjectKind)
    ? `用户发送了${subjectLabel}，但内容安全系统因为「${reason}」屏蔽了该${subjectLabel}。你应表现为知道用户发送了${subjectLabel}，但由于该原因不能查看、描述或评论该${subjectLabel}`
    : `${subjectLabel}已屏蔽：${reason}`];
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

function isVisualSubject(subjectKind: ModerationSubjectKind): boolean {
  return subjectKind === "image" || subjectKind === "emoji" || subjectKind === "local_media";
}

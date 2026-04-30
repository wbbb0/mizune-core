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
  auditKey?: string | undefined;
  markerConfig: AppConfig["contentSafety"]["marker"];
}): string {
  const subjectLabel = SUBJECT_LABELS[input.subjectKind];
  const reason = input.result.reason || "疑似违规";
  const lines = [
    "内容安全",
    `类型: ${subjectLabel}`,
    "状态: 已屏蔽",
    `原因: ${reason}`,
    isVisualSubject(input.subjectKind)
      ? `要求: 用户发送了${subjectLabel}，但该${subjectLabel}不可见；不要描述、猜测或评论${subjectLabel}内容，只能说明因内容安全原因无法查看。`
      : `要求: 原文不可见；不要复述或推测被屏蔽${subjectLabel}。`
  ];
  if (input.markerConfig.includeSubjectRef && input.subjectRef) {
    lines.push(`对象: ${input.subjectRef}`);
  }
  if (input.markerConfig.includeLabels && input.result.labels.length > 0) {
    lines.push(`标签: ${input.result.labels.map((item) => item.label).join(",")}`);
  }
  if (input.markerConfig.includeConfidence) {
    const confidence = input.result.labels
      .map((item) => item.confidence)
      .filter((item): item is number => typeof item === "number");
    if (confidence.length > 0) {
      lines.push(`置信度: ${Math.max(...confidence)}`);
    }
  }
  if (input.markerConfig.includeProvider) {
    lines.push(`来源: ${input.result.providerId}`);
  }
  if (input.auditKey) {
    lines.push(`auditKey: ${input.auditKey}`);
  }
  return `⟦${lines.join("\n")}⟧`;
}

function isVisualSubject(subjectKind: ModerationSubjectKind): boolean {
  return subjectKind === "image" || subjectKind === "emoji" || subjectKind === "local_media";
}

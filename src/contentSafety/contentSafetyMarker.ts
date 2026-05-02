import type { AppConfig } from "#config/config.ts";
import { formatStructuredEnvelope, type StructuredEnvelopeField } from "#utils/structuredEnvelope.ts";
import type { ModerationResult, ModerationSubjectKind } from "./contentSafetyTypes.ts";

const SUBJECT_LABELS: Record<ModerationSubjectKind, string> = {
  text: "内容",
  image: "图片",
  emoji: "表情",
  audio: "音频",
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
  const confidence = input.result.labels
    .map((item) => item.confidence)
    .filter((item): item is number => typeof item === "number");
  const fields: StructuredEnvelopeField[] = [
    { label: "类型", value: subjectLabel },
    { label: "状态", value: "已屏蔽" },
    { label: "原因", value: reason },
    {
      label: "要求",
      value: isVisualSubject(input.subjectKind)
        ? `用户发送了${subjectLabel}，但该${subjectLabel}不可见；不要描述、猜测或评论${subjectLabel}内容，只能说明因内容安全原因无法查看。`
        : `原文不可见；不要复述或推测被屏蔽${subjectLabel}。`
    },
    {
      label: "对象",
      value: input.markerConfig.includeSubjectRef ? input.subjectRef : undefined
    },
    {
      label: "标签",
      value: input.markerConfig.includeLabels && input.result.labels.length > 0
        ? input.result.labels.map((item) => item.label).join(",")
        : undefined
    },
    {
      label: "置信度",
      value: input.markerConfig.includeConfidence && confidence.length > 0
        ? Math.max(...confidence)
        : undefined
    },
    {
      label: "来源",
      value: input.markerConfig.includeProvider ? input.result.providerId : undefined
    },
    { label: "auditKey", value: input.auditKey }
  ];
  return formatStructuredEnvelope({ title: "内容安全", fields });
}

function isVisualSubject(subjectKind: ModerationSubjectKind): boolean {
  return subjectKind === "image" || subjectKind === "emoji" || subjectKind === "audio" || subjectKind === "local_media";
}

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  ImageModerationRequest,
  TextModerationRequest,
  TextModerationPlusRequest,
  type DescribeUploadTokenResponseBody,
  type ImageModerationResponseBody,
  type ImageModerationResponseBodyDataResult,
  type TextModerationPlusResponseBody,
  type TextModerationPlusResponseBodyDataResult,
  type TextModerationResponseBody
} from "@alicloud/green20220302";
import type { AppConfig } from "#config/config.ts";
import type {
  ContentModerationProvider,
  ModerateMediaInput,
  ModerateTextInput,
  ModerationDecision,
  ModerationLabel,
  ModerationResult
} from "../contentSafetyTypes.ts";

type ProviderConfig = AppConfig["contentSafety"]["providers"][string];

const DEFAULT_TEXT_SERVICE = "chat_detection";
const DEFAULT_IMAGE_SERVICE = "baselineCheck";
const ALLOW_TEXT_LABELS = new Set(["", "normal", "nonlabel", "none", "pass", "safe"]);
const require = createRequire(import.meta.url);
type AliyunGreenClientCtor = new (config: Record<string, unknown>) => {
  describeUploadToken: () => Promise<{ body?: DescribeUploadTokenResponseBody }>;
  textModeration: (request: TextModerationRequest) => Promise<{ body?: TextModerationResponseBody }>;
  textModerationPlus: (request: TextModerationPlusRequest) => Promise<{ body?: TextModerationPlusResponseBody }>;
  imageModeration: (request: ImageModerationRequest) => Promise<{ body?: ImageModerationResponseBody }>;
};
const aliyunGreenModule = require("@alicloud/green20220302") as { default?: AliyunGreenClientCtor };
const AliyunGreenClient = (aliyunGreenModule.default ?? aliyunGreenModule) as AliyunGreenClientCtor;
type OssClientCtor = new (config: Record<string, unknown>) => {
  put: (name: string, file: string) => Promise<{ url?: string }>;
  signatureUrl: (name: string, options?: Record<string, unknown>) => string;
};
const ossModule = require("ali-oss") as { default?: OssClientCtor };
const OssClient = (ossModule.default ?? ossModule) as OssClientCtor;

export function createAliyunContentModerationProvider(
  id: string,
  providerConfig: ProviderConfig
): ContentModerationProvider {
  const accessKeyId = resolveSecret(providerConfig.accessKeyId, providerConfig.accessKeyIdEnv);
  const accessKeySecret = resolveSecret(providerConfig.accessKeySecret, providerConfig.accessKeySecretEnv);
  const client = accessKeyId && accessKeySecret
    ? new AliyunGreenClient({
      accessKeyId,
      accessKeySecret,
      endpoint: providerConfig.endpoint,
      regionId: providerConfig.regionId
    })
    : null;

  return {
    id,
    type: "aliyun_content_moderation",
    capabilities: new Set(["text", "audio_transcript", "image", "emoji", "local_media"]),
    async moderateText(input: ModerateTextInput) {
      if (!client) {
        throw new Error("content safety aliyun_content_moderation provider is missing accessKeyId/accessKeySecret");
      }
      const service = providerConfig.services.text ?? DEFAULT_TEXT_SERVICE;
      const serviceParameters = JSON.stringify({
        content: input.text
      });
      if (isTextModerationPlusService(service)) {
        const response = await client.textModerationPlus(new TextModerationPlusRequest({
          service,
          serviceParameters
        }));
        return normalizeTextPlusResponse({
          providerId: id,
          body: response.body
        });
      }
      const response = await client.textModeration(new TextModerationRequest({
        service,
        serviceParameters
      }));
      return normalizeTextResponse({
        providerId: id,
        body: response.body
      });
    },
    async moderateMedia(input: ModerateMediaInput) {
      if (!client) {
        throw new Error("content safety aliyun_content_moderation provider is missing accessKeyId/accessKeySecret");
      }
      if (!input.absolutePath) {
        throw new Error("aliyun_content_moderation image moderation requires a public image URL; local chat files are not uploaded yet");
      }
      const imageUrl = isHttpUrl(input.absolutePath)
        ? input.absolutePath
        : null;
      const uploadedImage = imageUrl
        ? null
        : await uploadLocalImageForModeration(client, input.absolutePath, input.sourceName);
      const response = await client.imageModeration(new ImageModerationRequest({
        service: providerConfig.services.image ?? DEFAULT_IMAGE_SERVICE,
        serviceParameters: JSON.stringify({
          ...(imageUrl ? { imageUrl } : {}),
          ...(uploadedImage
            ? {
              ossBucketName: uploadedImage.bucketName,
              ossObjectName: uploadedImage.objectName
            }
            : {}),
          dataId: input.fileId ?? input.sourceName
        })
      }));
      return normalizeImageResponse({
        providerId: id,
        body: response.body
      });
    }
  };
}

function normalizeTextPlusResponse(input: {
  providerId: string;
  body: TextModerationPlusResponseBody | undefined;
}): ModerationResult {
  const body = input.body;
  ensureSuccess(body?.code, body?.message);
  const labels = [
    ...(body?.data?.result ?? []).map(toTextPlusLabel),
    ...(body?.data?.attackResult ?? [])
      .filter((item) => item.attackLevel && item.attackLevel !== "none")
      .map((item) => ({
        label: item.label ?? "prompt_attack",
        category: "prompt_attack",
        riskLevel: normalizeRiskLevel(item.attackLevel) ?? "medium",
        ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
        ...(item.description ? { providerReason: item.description } : {})
      } satisfies ModerationLabel)),
    ...(body?.data?.sensitiveResult ?? [])
      .filter((item) => item.sensitiveLevel && item.sensitiveLevel !== "S0")
      .map((item) => ({
        label: item.label ?? "sensitive_data",
        category: "sensitive_data",
        riskLevel: "medium",
        ...(item.description ? { providerReason: item.description } : {})
      } satisfies ModerationLabel))
  ].filter((item) => !ALLOW_TEXT_LABELS.has(item.label.toLowerCase()));
  const decision = decideTextPlus(body?.data?.riskLevel, labels);
  return {
    decision,
    reason: decision === "allow" ? "allowed" : buildReason(labels, body?.data?.riskLevel),
    labels,
    providerId: input.providerId,
    providerType: "aliyun_content_moderation",
    requestId: body?.requestId,
    rawDecision: body?.data?.riskLevel ?? "allow",
    checkedAtMs: Date.now()
  };
}

function normalizeTextResponse(input: {
  providerId: string;
  body: TextModerationResponseBody | undefined;
}): ModerationResult {
  const body = input.body;
  ensureSuccess(body?.code, body?.message);
  const labels = parseTextLabels(body?.data?.labels, body?.data?.descriptions, body?.data?.reason);
  const decision = labels.length > 0 ? "block" : "allow";
  return {
    decision,
    reason: decision === "allow" ? "allowed" : buildReason(labels, body?.data?.reason),
    labels,
    providerId: input.providerId,
    providerType: "aliyun_content_moderation",
    requestId: body?.requestId,
    rawDecision: body?.data?.labels ?? "allow",
    checkedAtMs: Date.now()
  };
}

function normalizeImageResponse(input: {
  providerId: string;
  body: ImageModerationResponseBody | undefined;
}): ModerationResult {
  const body = input.body;
  ensureSuccess(body?.code, body?.msg);
  const labels = (body?.data?.result ?? [])
    .map(toImageLabel)
    .filter((item) => !ALLOW_TEXT_LABELS.has(item.label.toLowerCase()));
  const decision = decideImage(body?.data?.riskLevel, labels);
  return {
    decision,
    reason: decision === "allow" ? "allowed" : buildReason(labels, body?.data?.riskLevel),
    labels,
    providerId: input.providerId,
    providerType: "aliyun_content_moderation",
    requestId: body?.requestId,
    rawDecision: body?.data?.riskLevel ?? "allow",
    checkedAtMs: Date.now()
  };
}

function parseTextLabels(labels: string | undefined, description: string | undefined, reason: string | undefined): ModerationLabel[] {
  return (labels ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => !ALLOW_TEXT_LABELS.has(item.toLowerCase()))
    .map((label) => ({
      label,
      riskLevel: "high",
      ...(description ? { providerReason: description } : {}),
      ...(reason ? { category: reason } : {})
    }));
}

function toImageLabel(item: ImageModerationResponseBodyDataResult): ModerationLabel {
  return {
    label: item.label ?? "unknown",
    riskLevel: normalizeRiskLevel(item.riskLevel),
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    ...(item.description ? { providerReason: item.description } : {})
  };
}

function toTextPlusLabel(item: TextModerationPlusResponseBodyDataResult): ModerationLabel {
  return {
    label: item.label ?? "unknown",
    riskLevel: item.label && ALLOW_TEXT_LABELS.has(item.label.toLowerCase()) ? "none" : "high",
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    ...(item.description ? { providerReason: item.description } : {}),
    ...(item.riskWords ? { category: item.riskWords } : {})
  };
}

function decideTextPlus(riskLevel: string | undefined, labels: ModerationLabel[]): ModerationDecision {
  const normalized = normalizeRiskLevel(riskLevel);
  if (normalized === "high" || labels.some((item) => item.riskLevel === "high")) {
    return "block";
  }
  if (normalized === "medium" || labels.some((item) => item.riskLevel === "medium")) {
    return "review";
  }
  return "allow";
}

function decideImage(riskLevel: string | undefined, labels: ModerationLabel[]): ModerationDecision {
  const normalized = normalizeRiskLevel(riskLevel);
  if (normalized === "high" || labels.some((item) => item.riskLevel === "high")) {
    return "block";
  }
  if (normalized === "medium" || labels.some((item) => item.riskLevel === "medium")) {
    return "review";
  }
  return "allow";
}

function normalizeRiskLevel(value: string | undefined): ModerationLabel["riskLevel"] {
  const normalized = value?.toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

function buildReason(labels: ModerationLabel[], fallback: string | undefined): string {
  const first = labels[0];
  return first
    ? `命中阿里云内容安全标签：${first.label}${first.providerReason ? `（${first.providerReason}）` : ""}`
    : fallback ?? "命中阿里云内容安全风险";
}

function ensureSuccess(code: number | undefined, message: string | undefined): void {
  if (code !== 200) {
    throw new Error(`aliyun content moderation failed: code=${code ?? "unknown"} message=${message ?? "unknown"}`);
  }
}

function resolveSecret(value: string | undefined, envName: string | undefined): string | undefined {
  return value ?? (envName ? process.env[envName] : undefined);
}

function isTextModerationPlusService(service: string): boolean {
  return service.endsWith("_pro") || service === "llm_query_moderation" || service === "llm_response_moderation";
}

async function uploadLocalImageForModeration(
  client: InstanceType<AliyunGreenClientCtor>,
  absolutePath: string,
  sourceName: string | undefined
): Promise<{ bucketName: string; objectName: string }> {
  const tokenResponse = await client.describeUploadToken();
  ensureSuccess(tokenResponse.body?.code, tokenResponse.body?.msg);
  const token = tokenResponse.body?.data;
  if (!token?.accessKeyId || !token.accessKeySecret || !token.securityToken || !token.bucketName || !token.ossInternetEndPoint || !token.fileNamePrefix) {
    throw new Error("aliyun content moderation upload token response is incomplete");
  }
  const objectName = `${token.fileNamePrefix}${randomUUID()}${extname(sourceName ?? absolutePath)}`;
  const ossClient = new OssClient({
    accessKeyId: token.accessKeyId,
    accessKeySecret: token.accessKeySecret,
    stsToken: token.securityToken,
    bucket: token.bucketName,
    endpoint: token.ossInternetEndPoint
  });
  await ossClient.put(objectName, absolutePath);
  return {
    bucketName: token.bucketName,
    objectName
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

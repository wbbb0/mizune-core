import { getRequestDiagnostic, attachRequestDiagnostic, type RequestDiagnostic } from "#llm/provider/requestDiagnostics.ts";
/** 可交给模型的有界诊断；不包含请求正文、认证头或完整网络地址。 */
export interface ImageFailureDetails {
  stage: "request" | "download";
  kind: "api" | "transport" | "protocol";
  modelRef: string;
  httpStatus?: number;
  code?: string;
  type?: string;
  param?: string;
  message: string;
  requestDiagnostic?: RequestDiagnostic;
}

export class ImageGenerationError extends Error {
  constructor(readonly details: ImageFailureDetails) {
    super(`图像${details.stage === "download" ? "下载" : "生成"}失败${details.httpStatus ? ` HTTP ${details.httpStatus}` : ""}${details.code ? ` [${details.code}]` : ""}：${details.message}`);
    this.name = "ImageGenerationError";
    if (details.requestDiagnostic) attachRequestDiagnostic(this, details.requestDiagnostic);
  }
}

export function sanitizeImageDiagnostic(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("[已隐藏]");
  return result.replace(/https?:\/\/[^\s"'<>]+/gi, "[网络地址]")
    .replace(/Bearer\s+[^\s",}]+/gi, "Bearer [已隐藏]").slice(0, 4096);
}

export function imageApiFailure(body: string, stage: ImageFailureDetails["stage"], modelRef: string,
  httpStatus: number, secrets: string[]): ImageGenerationError {
  let value: unknown;
  try { value = JSON.parse(body); } catch { /* 文本错误也保留有界说明。 */ }
  const root = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const nested = root?.error;
  const record = nested && typeof nested === "object" ? nested as Record<string, unknown> : root;
  const clean = (value: unknown) => typeof value === "string" || typeof value === "number"
    ? sanitizeImageDiagnostic(String(value), secrets) : undefined;
  return new ImageGenerationError({ stage, kind: "api", modelRef, httpStatus,
    ...(clean(record?.code) ? { code: clean(record?.code)! } : {}),
    ...(clean(record?.type) ? { type: clean(record?.type)! } : {}),
    ...(clean(record?.param) ? { param: clean(record?.param)! } : {}),
    message: clean(record?.message) || clean(nested) || sanitizeImageDiagnostic(body, secrets) || "接口未提供错误说明"
  });
}

export function imageTransportFailure(error: unknown, stage: ImageFailureDetails["stage"], modelRef: string,
  secrets: string[]): ImageGenerationError {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || !value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const item = value as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof item.message === "string") messages.push(item.message);
    if (typeof item.code === "string") messages.push(item.code);
    visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) for (const child of item.errors.slice(0, 4)) visit(child, depth + 1);
  };
  visit(error, 0);
  const diagnostic = getRequestDiagnostic(error);
  return new ImageGenerationError({ stage, kind: "transport", modelRef,
    ...(diagnostic ? { requestDiagnostic: diagnostic } : {}),
    message: messages.map(message => sanitizeImageDiagnostic(message, secrets)).join("；").slice(0, 4096) || "网络请求失败"
  });
}

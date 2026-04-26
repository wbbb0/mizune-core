export function formatUploadErrorMessage(error: unknown): string {
  return formatComposerErrorMessage(error, "上传失败");
}

export function formatSendErrorMessage(error: unknown): string {
  return formatComposerErrorMessage(error, "发送失败");
}

function formatComposerErrorMessage(error: unknown, fallback: string): string {
  const detail = extractErrorDetail(error);
  return detail ? `${fallback}：${detail}` : `${fallback}：未知错误`;
}

function extractErrorDetail(error: unknown): string | null {
  if (typeof error === "string") {
    return normalizeMessage(error);
  }

  if (error instanceof Error) {
    return normalizeMessage(error.message) ?? extractStatusDetail(error);
  }

  if (!error || typeof error !== "object") {
    return null;
  }

  const record = error as Record<string, unknown>;
  return normalizeMessage(record.error)
    ?? normalizeMessage(record.message)
    ?? normalizeMessage(record.detail)
    ?? normalizeMessage(record.reason)
    ?? extractStatusDetail(record);
}

function normalizeMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const message = value.trim();
  return message.length > 0 ? message : null;
}

function extractStatusDetail(value: object): string | null {
  const status = (value as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return `HTTP ${status}`;
  }
  if (typeof status === "string") {
    const normalized = status.trim();
    return normalized ? `HTTP ${normalized}` : null;
  }
  return null;
}

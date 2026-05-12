import type { OneBotApiResponse, OneBotSendResult } from "./types.ts";

export interface NapCatFileSendTarget {
  userId?: string;
  groupId?: string;
  filePath: string;
  name?: string | null;
}

export async function sendNapCatFile(
  postApi: <T extends OneBotApiResponse>(endpoint: string, body: Record<string, unknown>) => Promise<T>,
  target: NapCatFileSendTarget
): Promise<OneBotSendResult> {
  const endpoint = target.groupId != null ? "upload_group_file" : "upload_private_file";
  const numericId = target.groupId != null
    ? parseRequiredNumericId(target.groupId, "groupId")
    : parseRequiredNumericId(target.userId, "userId");
  const body = target.groupId != null
    ? {
        group_id: numericId,
        file: target.filePath,
        ...(target.name ? { name: target.name } : {})
      }
    : {
        user_id: numericId,
        file: target.filePath,
        ...(target.name ? { name: target.name } : {})
      };

  return postApi<OneBotSendResult>(endpoint, body);
}

function parseRequiredNumericId(value: string | undefined, label: "userId" | "groupId"): number {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`NapCat file upload requires ${label}`);
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    throw new Error(`NapCat file upload requires numeric ${label}`);
  }
  return numeric;
}

import type { ChatFileRecord } from "../types.ts";

export interface MediaScope { connectionId: string; sessionId: string }
export type MediaKind = "image" | "emoji" | "file" | "video";
export type MediaLocator =
  | { kind: "onebot_message"; id: string; imageIndex: number }
  | { kind: "onebot_forward"; id: string; nodeIndex: number; imageIndex: number };
export interface MediaSourceInput {
  kind: MediaKind;
  source: string;
  sourceName?: string | null | undefined;
  mimeType?: string | null | undefined;
  locator?: MediaLocator | undefined;
  sourceContext?: Record<string, string | number | boolean | null> | undefined;
}
export interface MediaSourceRecord extends MediaScope {
  id: string;
  key: string;
  input: MediaSourceInput;
  assetId: string | null;
  failures: number;
  nextRetryAt: number;
  expiresAt: number;
  version: number;
}
export interface MediaSourceRepository {
  register(scope: MediaScope, input: MediaSourceInput, signal?: AbortSignal): Promise<MediaSourceRecord>;
  get(scope: MediaScope, id: string): Promise<MediaSourceRecord | null>;
  save(record: MediaSourceRecord, signal?: AbortSignal): Promise<boolean>;
}
export type MediaResolution = { ref: string; kind: MediaKind; file: ChatFileRecord };

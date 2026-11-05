import type { AppConfig } from "#config/config.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { ChatFileRecord } from "#services/workspace/types.ts";
import type { CharacterProfile, CharacterStage } from "./model.ts";
import { characterRepository, type CharacterCommitGuard, type CharacterEditAction, type CharacterEditResult } from "./repository.ts";
import type { JsonObject } from "./schemaCatalog.ts";

export type CharacterAssetStore = Pick<ChatFileStore, "getFile" | "isFileAvailable" | "withRetainedFiles">;
export type CharacterAssetValidationConfig = { chatFiles?: AppConfig["chatFiles"] | undefined };
export interface CharacterWriteContext {
  dataDir: string;
  config?: CharacterAssetValidationConfig | undefined;
  chatFileStore?: CharacterAssetStore | undefined;
  abortSignal?: AbortSignal | undefined;
  assertCurrent?: (() => void) | undefined;
}

function requireAssets(store: CharacterAssetStore | undefined): CharacterAssetStore {
  if (!store || typeof store.getFile !== "function" || typeof store.isFileAvailable !== "function"
    || typeof store.withRetainedFiles !== "function") {
    throw new Error("角色图片资产依赖未正确装配：需要查询、文件可用性检查与临时保留能力");
  }
  return store;
}

export function referenceImageFileIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.flatMap(item => typeof item?.fileId === "string" && item.fileId.trim()
    ? [item.fileId.trim()] : []))];
}

export async function validateReferenceImageFileId(
  fileId: string, assets: CharacterAssetStore, config?: CharacterAssetValidationConfig
): Promise<ChatFileRecord> {
  if (config?.chatFiles && !config.chatFiles.enabled) throw new Error("统一资产库未启用，无法使用角色设定图资产");
  const record = await assets.getFile(fileId);
  if (!record) throw new Error(`未找到静态图片资产：${fileId}`);
  if (record.kind !== "image") throw new Error(`角色参考图必须是静态图片资产，当前类型为 ${record.kind}：${fileId}`);
  if (!await assets.isFileAvailable(fileId)) throw new Error(`图片资产文件不可读或已丢失：${fileId}`);
  return record;
}

export async function withRetainedCharacterAssets<T>(
  assets: CharacterAssetStore, fileIds: Iterable<string>, operation: () => Promise<T> | T
): Promise<T> {
  return requireAssets(assets).withRetainedFiles([...new Set(fileIds)], operation);
}

/** 异步准备不持有角色事务；所有写入在事务内再次检查操作有效性。 */
async function writeWithAssets<T>(input: CharacterWriteContext, fileIds: string[], commit: (guard: CharacterCommitGuard) => T): Promise<T> {
  const assertCurrent = () => {
    input.abortSignal?.throwIfAborted();
    input.assertCurrent?.();
  };
  assertCurrent();
  if (!fileIds.length) return commit({ assertCurrent });
  const assets = requireAssets(input.chatFileStore);
  return withRetainedCharacterAssets(assets, fileIds, async () => {
    assertCurrent();
    for (const fileId of fileIds) {
      await validateReferenceImageFileId(fileId, assets, input.config);
      assertCurrent();
    }
    return commit({ assertCurrent });
  });
}

export async function editCharacterSectionWithAssets(input: CharacterWriteContext & {
  sessionId: string; modeId: string; id: string; action: CharacterEditAction;
  value?: unknown; itemId?: string | undefined; draftId?: string | undefined;
}): Promise<CharacterEditResult | undefined> {
  const store = characterRepository(input.dataDir);
  const draft = store.draft(input.sessionId);
  if (input.draftId !== draft?.id) throw new Error("配置阶段已变化，请重新读取目录");
  const section = store.section(input.sessionId, input.modeId, input.id);
  if (!section.writable) throw new Error("当前阶段此分块为只读，不能修改");
  const candidate = input.value as JsonObject | undefined;
  const targetId = input.itemId ?? (section.collectionKey && candidate && typeof candidate === "object"
    ? candidate[section.collectionKey] : undefined);
  const previous = section.collectionKey && typeof targetId === "string"
    ? (section.value as JsonObject[]).find(item => item[section.collectionKey!] === targetId) : undefined;
  if (input.action === "update" && !previous) throw new Error("itemId 不存在，请重新读取已有条目");
  const expected = previous
    ? { id: section.id, itemId: targetId as string, value: previous }
    : { id: section.id, value: section.value };
  const files = input.id !== "social.referenceImages" ? []
    : input.action === "update" ? referenceImageFileIds([previous])
      : input.action === "set" ? referenceImageFileIds(input.value)
        : input.action === "upsert" || input.action === "add" ? referenceImageFileIds([input.value]) : [];
  return writeWithAssets(input, files, guard => store.edit(
    input.sessionId, input.modeId, input.id, input.action, input.value, input.itemId, input.draftId,
    { ...guard, section: expected }
  ));
}

function profileFileIds(value: unknown): string[] {
  return referenceImageFileIds((value as CharacterProfile | null)?.social?.referenceImages);
}

export async function validateCharacterProfileWithAssets(input: CharacterWriteContext & { value: unknown }): Promise<CharacterProfile> {
  const store = characterRepository(input.dataDir);
  const candidate = store.validateProfile(input.value);
  return writeWithAssets(input, profileFileIds(candidate), () => store.validateProfile(candidate));
}

export async function saveCharacterProfileWithAssets(input: CharacterWriteContext & { value: unknown }): Promise<CharacterProfile> {
  const store = characterRepository(input.dataDir);
  const candidate = store.validateProfile(input.value);
  return writeWithAssets(input, profileFileIds(candidate), guard => store.saveProfile(candidate, guard.assertCurrent));
}

export async function confirmCharacterDraftWithAssets(input: CharacterWriteContext & {
  sessionId: string; modeId: string;
}): Promise<CharacterStage> {
  const store = characterRepository(input.dataDir);
  const draft = store.draft(input.sessionId);
  if (!draft) throw new Error("没有待确认的角色草稿");
  const fileIds = draft.stage === "social" ? profileFileIds(draft.value) : [];
  return writeWithAssets(input, fileIds, guard => store.confirm(input.sessionId, input.modeId, { ...guard, draft }));
}

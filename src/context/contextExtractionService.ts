import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { bigramJaccardSimilarity, isNearDuplicateText, normalizeTitleForDedup } from "#memory/similarity.ts";
import type { UserMemoryKind } from "#memory/userMemoryEntry.ts";
import type { ContextStore } from "./contextStore.ts";
import type { ContextMemoryFactEntry, ContextScope } from "./contextTypes.ts";

export interface ContextExtractionTurnMessage {
  userId: string;
  senderName: string;
  text: string;
  receivedAt: number;
}

export interface ContextExtractionTurn {
  sessionId: string;
  userId: string;
  chatType: "private" | "group";
  senderName: string;
  userMessages: ContextExtractionTurnMessage[];
  assistantText: string;
  completedAt: number;
}

interface ExtractionCandidate {
  action: "create" | "replace" | "ignore";
  operation?: "noop" | "create" | "update_existing" | "invalidate_and_create" | "merge" | "ignore_wrong_scope";
  scope?: ContextScope;
  replaceMemoryId?: string;
  targetMemoryId?: string;
  conflictsWithMemoryIds?: string[];
  slotKey?: string;
  title?: string;
  content?: string;
  kind?: UserMemoryKind;
  importance?: number;
  confidence?: number;
}

interface ExtractionResponse {
  items?: ExtractionCandidate[];
}

export interface ContextExtractionResult {
  created: number;
  replaced: number;
  ignored: number;
  items: ContextExtractionResultItem[];
}

export interface ContextExtractionResultItem {
  result: "created" | "replaced" | "ignored";
  scope?: Extract<ContextScope, "user" | "session">;
  operation?: ExtractionOperation;
  memoryId?: string;
  targetMemoryIds?: string[];
  slotKey?: string;
  title?: string;
  content?: string;
  kind?: UserMemoryKind;
  reason?: string;
}

type ContextExtractionStore = Pick<ContextStore, "listUserFacts" | "upsertUserFact" | "listSessionFacts" | "upsertSessionFact">;
export type ExtractionOperation = NonNullable<ExtractionCandidate["operation"]>;
type NormalizedExtractionCandidate = Required<Omit<
  ExtractionCandidate,
  "replaceMemoryId" | "targetMemoryId" | "conflictsWithMemoryIds" | "slotKey" | "scope" | "operation"
>> & {
  scope: ContextScope;
  operation: ExtractionOperation;
  targetMemoryId?: string;
  conflictsWithMemoryIds: string[];
  slotKey?: string;
};
type ScopedMemoryEntry = ContextMemoryFactEntry & { scope: "user" | "session" };

const MAX_RELATED_MEMORIES = 20;
const MAX_MESSAGE_TEXT_CHARS = 500;
const MAX_TOTAL_MESSAGE_TEXT_CHARS = 4000;

export class ContextExtractionService {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: Pick<LlmClient, "generate" | "isConfigured">,
    private readonly contextStore: ContextExtractionStore,
    private readonly logger: Logger
  ) { }

  async processTurns(input: {
    sessionId: string;
    userId: string;
    turns: ContextExtractionTurn[];
  }): Promise<ContextExtractionResult> {
    const config = this.config.context.extraction;
    if (!config.enabled || !this.config.llm.summarizer.enabled) {
      return emptyExtractionResult();
    }
    try {
      const targetUserMessages = input.turns.flatMap((turn) => (
        turn.userMessages.filter((message) => message.userId === input.userId && message.text.trim().length > 0)
      ));
      if (targetUserMessages.length === 0) {
        return emptyExtractionResult();
      }
      const currentTurnMessages = input.turns.flatMap((turn) => (
        turn.userMessages.filter((message) => message.text.trim().length > 0)
      ));
      const conversationText = currentTurnMessages.map((message) => message.text.trim()).join("\n").trim();
      if (!conversationText) {
        return emptyExtractionResult();
      }

      const modelRefs = getModelRefsForRole(this.config, "summarizer");
      if (!this.llmClient.isConfigured(modelRefs)) {
        this.logger.warn({
          sessionId: input.sessionId,
          userId: input.userId,
          modelRefs
        }, "context_extraction_skipped_llm_unconfigured");
        return emptyExtractionResult();
      }

      const existingMemories = this.contextStore.listUserFacts(input.userId);
      const existingSessionMemories = this.contextStore.listSessionFacts(input.sessionId);
      const targetUserText = targetUserMessages.map((message) => message.text.trim()).join("\n").trim();
      const relatedMemories = selectRelatedMemories(
        [
          ...existingMemories.map((memory): ScopedMemoryEntry => ({ ...memory, scope: "user" })),
          ...existingSessionMemories.map((memory): ScopedMemoryEntry => ({ ...memory, scope: "session" }))
        ],
        targetUserText || conversationText,
        config.relatedMemoryLimit
      );
      const response = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        timeoutMsOverride: config.timeoutMs,
        enableThinkingOverride: this.config.llm.summarizer.enableThinking && config.enableThinking,
        skipDebugDump: true,
        messages: buildExtractionPrompt({
          sessionId: input.sessionId,
          userId: input.userId,
          turns: input.turns,
          targetUserMessages,
          currentTurnMessages,
          relatedMemories
        })
      });
      const parsed = parseExtractionResponse(response.text);
      return this.applyCandidates({
        userId: input.userId,
        sessionId: input.sessionId,
        candidates: parsed.items ?? [],
        existingMemories,
        existingSessionMemories,
        minConfidence: config.minConfidence
      });
    } catch (error) {
      this.logger.warn({
        sessionId: input.sessionId,
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error)
      }, "context_extraction_process_failed_open");
      return emptyExtractionResult();
    }
  }

  private applyCandidates(input: {
    userId: string;
    sessionId: string;
    candidates: ExtractionCandidate[];
    existingMemories: ContextMemoryFactEntry[];
    existingSessionMemories: ContextMemoryFactEntry[];
    minConfidence: number;
  }): ContextExtractionResult {
    let created = 0;
    let replaced = 0;
    let ignored = 0;
    const items: ContextExtractionResultItem[] = [];
    const existingById = new Map(input.existingMemories.map((item) => [item.id, item]));
    const existingSessionById = new Map(input.existingSessionMemories.map((item) => [item.id, item]));
    const acceptedTexts: string[] = input.existingMemories.map((item) => `${item.title}\n${item.content}`);
    const acceptedSessionTexts: string[] = input.existingSessionMemories.map((item) => `${item.title}\n${item.content}`);

    for (const candidate of input.candidates) {
      const normalized = normalizeCandidate(candidate);
      if (!normalized || normalized.confidence < input.minConfidence || normalized.action === "ignore" || normalized.operation === "noop") {
        ignored += 1;
        items.push(buildIgnoredExtractionItem(candidate, normalized, normalized ? "ignored_by_model_or_confidence" : "invalid_candidate"));
        continue;
      }
      if (normalized.scope !== "user" && normalized.scope !== "session") {
        ignored += 1;
        items.push(buildIgnoredExtractionItem(candidate, normalized, "unsupported_scope"));
        continue;
      }
      if (normalized.operation === "ignore_wrong_scope") {
        ignored += 1;
        items.push(buildIgnoredExtractionItem(candidate, normalized, "wrong_scope"));
        continue;
      }
      const memoryText = `${normalized.title}\n${normalized.content}`;
      const scopeMemories = normalized.scope === "session" ? input.existingSessionMemories : input.existingMemories;
      const scopeExistingById = normalized.scope === "session" ? existingSessionById : existingById;
      const replacementTarget = resolveReplacementTarget(normalized, scopeMemories, scopeExistingById);
      const replacingExisting = replacementTarget != null;
      const needsExistingTarget = normalized.action === "replace"
        || normalized.operation === "update_existing"
        || normalized.operation === "merge";
      if (needsExistingTarget && !replacementTarget) {
        ignored += 1;
        items.push(buildIgnoredExtractionItem(candidate, normalized, "missing_replacement_target"));
        continue;
      }
      if (replacementTarget && isSameExtractionMemory(normalized, replacementTarget)) {
        ignored += 1;
        items.push(buildIgnoredExtractionItem(candidate, normalized, "same_as_existing"));
        continue;
      }
      const writeMode = normalized.operation === "invalidate_and_create"
        ? "supersede_existing" as const
        : "update_existing" as const;
      const supersedeMemoryIds = normalized.operation === "invalidate_and_create"
        ? collectCandidateTargetMemoryIds(normalized, replacementTarget, scopeExistingById)
        : [];
      const acceptedScopeTexts = normalized.scope === "session" ? acceptedSessionTexts : acceptedTexts;
      if (!replacingExisting && !normalized.slotKey && isNearDuplicateText(memoryText, acceptedScopeTexts)) {
        ignored += 1;
        items.push(buildIgnoredExtractionItem(candidate, normalized, "near_duplicate"));
        continue;
      }

      try {
        const now = Date.now();
        const result = normalized.scope === "session"
          ? this.contextStore.upsertSessionFact({
              sessionId: input.sessionId,
              ...(replacementTarget && writeMode !== "supersede_existing" ? { memoryId: replacementTarget.id } : {}),
              ...(normalized.slotKey ? { slotKey: normalized.slotKey } : replacementTarget?.slotKey ? { slotKey: replacementTarget.slotKey } : {}),
              ...(supersedeMemoryIds.length > 0 ? { supersedeMemoryIds } : {}),
              writeMode,
              title: normalized.title,
              content: normalized.content,
              kind: normalized.kind,
              source: "inferred",
              importance: normalized.importance,
              validTo: buildSessionFactValidTo(this.config, now),
              lastConfirmedAt: now
            })
          : this.contextStore.upsertUserFact({
              userId: input.userId,
              ...(replacementTarget && writeMode !== "supersede_existing" ? { memoryId: replacementTarget.id } : {}),
              ...(normalized.slotKey ? { slotKey: normalized.slotKey } : replacementTarget?.slotKey ? { slotKey: replacementTarget.slotKey } : {}),
              ...(supersedeMemoryIds.length > 0 ? { supersedeMemoryIds } : {}),
              writeMode,
              title: normalized.title,
              content: normalized.content,
              kind: normalized.kind,
              source: "inferred",
              importance: normalized.importance
            });
        if (replacingExisting || result.action === "updated_existing") {
          replaced += 1;
        } else {
          created += 1;
        }
        items.push({
          result: replacingExisting || result.action === "updated_existing" ? "replaced" : "created",
          scope: normalized.scope,
          operation: normalized.operation,
          memoryId: result.item.id,
          targetMemoryIds: supersedeMemoryIds.length > 0
            ? supersedeMemoryIds
            : replacementTarget ? [replacementTarget.id] : [],
          ...(normalized.slotKey ? { slotKey: normalized.slotKey } : replacementTarget?.slotKey ? { slotKey: replacementTarget.slotKey } : {}),
          title: normalized.title,
          content: normalized.content,
          kind: normalized.kind
        });
        acceptedScopeTexts.push(memoryText);
      } catch (error) {
        ignored += 1;
        items.push(buildIgnoredExtractionItem(candidate, normalized, "apply_failed"));
        this.logger.warn({
          sessionId: input.sessionId,
          userId: input.userId,
          title: normalized.title,
          error: error instanceof Error ? error.message : String(error)
        }, "context_extraction_memory_apply_failed_open");
      }
    }

    this.logger.info({
      sessionId: input.sessionId,
      userId: input.userId,
      created,
      replaced,
      ignored
    }, "context_extraction_applied");
    return { created, replaced, ignored, items };
  }
}

function selectRelatedMemories(
  memories: ScopedMemoryEntry[],
  queryText: string,
  limit: number
): ScopedMemoryEntry[] {
  if (limit <= 0 || memories.length === 0) {
    return [];
  }
  if (memories.length <= Math.min(limit, MAX_RELATED_MEMORIES)) {
    return memories.slice(0, limit);
  }
  return memories
    .map((memory) => ({
      memory,
      score: scoreRelatedMemory(memory, queryText)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt - left.memory.updatedAt)
    .slice(0, Math.min(limit, MAX_RELATED_MEMORIES))
    .map((item) => item.memory);
}

function scoreRelatedMemory(memory: ContextMemoryFactEntry, queryText: string): number {
  const text = `${memory.title}\n${memory.content}`;
  const normalizedTitle = normalizeTitleForDedup(memory.title);
  let score = isNearDuplicateText(queryText, [text], 0.42) ? 2 : 0;
  if (memory.slotKey && hasAnyText(queryText, slotKeyQueryHints(memory.slotKey))) {
    score += 4;
  }
  if (normalizedTitle && queryText.includes(normalizedTitle)) {
    score += 2;
  }
  for (const term of ["早餐", "称呼", "叫我", "名字", "昵称", "口吻", "时区", "职业", "工作", "城市", "住", "搬", "地址", "所在地", "常住地", "边界", "偏好"]) {
    if (queryText.includes(term) && text.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function slotKeyQueryHints(slotKey: string): string[] {
  switch (slotKey) {
    case "preferred_name":
      return ["preferred_name", "称呼", "叫我", "名字", "昵称"];
    case "residence":
      return ["residence", "所在地", "常住地", "住", "搬", "地址", "城市"];
    case "timezone":
      return ["timezone", "时区", "时间"];
    case "occupation":
      return ["occupation", "职业", "工作", "身份"];
    case "communication_preference":
      return ["communication_preference", "回答", "回复", "口吻", "风格", "偏好"];
    case "breakfast_habit":
      return ["breakfast_habit", "早餐", "早饭"];
    case "session_purpose":
      return ["session_purpose", "此会话", "这个会话", "本会话", "专门用于", "主题"];
    case "project_focus":
      return ["project_focus", "项目", "关注", "目标"];
    case "boundary":
      return ["boundary", "边界", "不要", "不希望"];
    default:
      return [slotKey];
  }
}

function hasAnyText(text: string, needles: string[]): boolean {
  return needles.some((needle) => needle.length > 0 && text.includes(needle));
}

function buildExtractionPrompt(input: {
  sessionId: string;
  userId: string;
  turns: ContextExtractionTurn[];
  targetUserMessages: ContextExtractionTurnMessage[];
  currentTurnMessages: ContextExtractionTurnMessage[];
  relatedMemories: ScopedMemoryEntry[];
}): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是聊天记忆抽取器，负责判断当前轮对话是否需要更新上下文记忆。",
        "当前实现可以写入 scope=user 的长期用户事实，也可以写入 scope=session 的当前会话事实；其他 scope 必须识别出来但不要写入。",
        "scope=user：只记录稳定、长期可复用、绑定 target_user_id 本人的事实，例如称呼、身份、职业、所在地、时区、长期偏好、长期习惯、明确边界、关系备注。",
        "scope=session：只在当前 sessionId 内生效的信息，例如“此会话专门用于某项目/某测试/某主题”“本群这轮讨论只追踪某事项”“本会话接下来都围绕某目标”。这类内容应输出 create/replace 且 scope=session。",
        "scope=global：所有用户和会话都适用的长期规则或运行偏好，例如全局回答原则、所有任务默认流程。当前 schema 尚不能写 global 记忆，必须输出 ignore。",
        "scope=toolset：只和某类工具集/工具能力有关的长期规则，例如 shell、浏览器、workspace、ComfyUI 的默认使用规则。当前 schema 尚不能写 toolset 记忆，必须输出 ignore。",
        "scope=mode：只和特定运行模式/角色模式有关的规则，例如 scenario_host 或 assistant mode 的行为边界。当前 schema 尚不能写 mode 记忆，必须输出 ignore。",
        "输入会包含当前 debounce batch 的完整对话；为 scope=user 写入时只能为 target_user_id 对应用户抽取记忆。",
        "群聊中其他人的话只作为上下文，不要把其他群成员的信息写到 target_user_id 身上。",
        "不要把 session/global/toolset/mode 范围的信息降级写成 user 记忆；session 范围必须显式写 scope=session。",
        "特别注意：用户说“以后所有任务默认……”“所有会话都……”“全局默认……”“任何时候都……”这类内容是 global/procedural 规则，不是 target_user_id 的用户画像或个人偏好；当前必须输出 ignore，不能写 scope=user。",
        "可写 user 的偏好必须是用户本人长期属性或个人交流偏好，例如“叫我阿明”“我住杭州”“我喜欢简洁回答”；不可写 user 的规则包括“所有任务先列计划”“默认每次都执行某流程”“以后所有项目都使用某工具”。",
        "不要记录一次性任务、临时状态、当前正在做的事、普通闲聊、问题本身、助手猜测、助手为了本轮任务做出的总结。",
        "输入中的 related_memories 是与当前对话相关的已有记忆，必须优先用于判断是否更新、合并或替换旧记忆，而不是创建重复条目。",
        "每条可写记忆都必须尽量输出 slotKey。slotKey 是同一主体下只能保留一个当前值的稳定槽位，用小写英文和下划线表示。",
        "常用 slotKey：preferred_name=用户希望被如何称呼；residence=常住地/所在地；timezone=时区；occupation=职业/身份；communication_preference=长期交流偏好；breakfast_habit=早餐习惯；session_purpose=当前会话用途；project_focus=当前会话或项目关注点；boundary=长期边界。",
        "如果新信息是对 related_memories 中旧信息的更正、变更、补充或同槽位新值，应输出 operation=update_existing，并填写 targetMemoryId。",
        "如果旧信息需要保留审计但不应继续作为当前值，应输出 operation=invalidate_and_create，并填写 targetMemoryId、slotKey 和 conflictsWithMemoryIds。",
        "如果新信息只是补充同一事实并能合并进旧条目，应输出 operation=merge，并填写 targetMemoryId；content 应给出合并后的完整当前事实。",
        "如果确实是新槽位或 related_memories 中没有同类事实，才输出 operation=create。",
        "如果信息属于 global/toolset/mode 或不该写入当前 schema，输出 action=ignore、operation=ignore_wrong_scope，并保留正确 scope。",
        "判定示例：用户说“以后所有任务默认先列三步计划。”，应输出 {\"items\":[{\"action\":\"ignore\",\"scope\":\"global\",\"confidence\":1}]}，绝不能写成 user 偏好。",
        "判定示例：用户说“以后请叫我阿明。”，应输出 scope=user、operation=create、slotKey=preferred_name。",
        "判定示例：related_memories 里已有 preferred_name=阿明，用户说“以后叫我小王。”，应输出 scope=user、operation=update_existing、targetMemoryId=对应 id、slotKey=preferred_name。",
        "判定示例：related_memories 里已有 residence=上海，用户说“我现在搬到杭州了。”，应输出 scope=user、operation=invalidate_and_create、targetMemoryId=对应 id、conflictsWithMemoryIds=[对应 id]、slotKey=residence。",
        "判定示例：用户说“此会话专门用于记忆系统测试。”，应输出 scope=session、operation=create、slotKey=session_purpose。",
        "判定示例：用户说“帮我临时算一下 37 加 58。”，应输出 {\"items\":[]}。",
        "如果没有值得长期保存的信息，输出 {\"items\":[]}。",
        "只输出 JSON，不要解释。JSON 格式：{\"items\":[{\"action\":\"create|replace|ignore\",\"operation\":\"noop|create|update_existing|invalidate_and_create|merge|ignore_wrong_scope\",\"scope\":\"user|session|global|toolset|mode\",\"targetMemoryId\":\"可选\",\"conflictsWithMemoryIds\":[\"可选\"],\"slotKey\":\"可选\",\"title\":\"短标题\",\"content\":\"完整记忆内容\",\"kind\":\"preference|fact|boundary|habit|relationship|other\",\"importance\":1-5,\"confidence\":0-1}]}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        sessionId: input.sessionId,
        target_user_id: input.userId,
        target_user_messages: limitPromptMessages(input.targetUserMessages).map((message) => ({
          senderName: message.senderName,
          text: truncatePromptText(message.text),
          receivedAt: message.receivedAt
        })),
        current_turn_messages: limitPromptMessages(input.currentTurnMessages).map((message) => ({
          userId: message.userId,
          senderName: message.senderName,
          isTargetUser: message.userId === input.userId,
          text: truncatePromptText(message.text),
          receivedAt: message.receivedAt
        })),
        assistant_replies: input.turns
          .map((turn) => turn.assistantText.trim())
          .filter((text) => text.length > 0),
        related_memories: input.relatedMemories.map((memory) => ({
          scope: memory.scope,
          id: memory.id,
          slotKey: memory.slotKey,
          title: memory.title,
          content: memory.content,
          kind: memory.kind,
          importance: memory.importance
        }))
      }, null, 2)
    }
  ];
}

function limitPromptMessages(messages: ContextExtractionTurnMessage[]): ContextExtractionTurnMessage[] {
  const selected: ContextExtractionTurnMessage[] = [];
  let totalChars = 0;
  for (const message of messages) {
    const text = message.text.trim();
    if (!text) {
      continue;
    }
    const nextChars = Math.min(text.length, MAX_MESSAGE_TEXT_CHARS);
    if (selected.length > 0 && totalChars + nextChars > MAX_TOTAL_MESSAGE_TEXT_CHARS) {
      break;
    }
    selected.push(message);
    totalChars += nextChars;
  }
  return selected;
}

function truncatePromptText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_MESSAGE_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_MESSAGE_TEXT_CHARS)}...`
    : trimmed;
}

function resolveReplacementTarget(
  candidate: NormalizedExtractionCandidate,
  existingMemories: ContextMemoryFactEntry[],
  existingById: Map<string, ContextMemoryFactEntry>
): ContextMemoryFactEntry | null {
  if (candidate.slotKey) {
    const sameSlotMatches = existingMemories.filter((memory) => memory.slotKey === candidate.slotKey);
    if (sameSlotMatches.length > 0) {
      return sameSlotMatches[0] ?? null;
    }
  }
  if (candidate.action !== "replace"
    && candidate.operation !== "update_existing"
    && candidate.operation !== "invalidate_and_create"
    && candidate.operation !== "merge") {
    return null;
  }
  if (candidate.targetMemoryId) {
    return existingById.get(candidate.targetMemoryId) ?? null;
  }
  const conflictMatches = candidate.conflictsWithMemoryIds
    .map((id) => existingById.get(id) ?? null)
    .filter((memory): memory is ContextMemoryFactEntry => memory != null);
  if (conflictMatches.length === 1) {
    return conflictMatches[0] ?? null;
  }
  return findUniqueReplacementTarget(candidate, existingMemories);
}

function collectCandidateTargetMemoryIds(
  candidate: NormalizedExtractionCandidate,
  replacementTarget: ContextMemoryFactEntry | null,
  existingById: Map<string, ContextMemoryFactEntry>
): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined) => {
    if (!id || ids.includes(id) || !existingById.has(id)) {
      return;
    }
    ids.push(id);
  };
  add(replacementTarget?.id);
  add(candidate.targetMemoryId);
  for (const id of candidate.conflictsWithMemoryIds) {
    add(id);
  }
  return ids;
}

function isSameExtractionMemory(
  candidate: NormalizedExtractionCandidate,
  existing: ContextMemoryFactEntry
): boolean {
  return normalizeTitleForDedup(candidate.title) === normalizeTitleForDedup(existing.title)
    && candidate.content.trim() === existing.content.trim();
}

function buildIgnoredExtractionItem(
  candidate: ExtractionCandidate,
  normalized: NormalizedExtractionCandidate | null,
  reason: string
): ContextExtractionResultItem {
  return {
    result: "ignored",
    ...(normalized?.scope === "user" || normalized?.scope === "session" ? { scope: normalized.scope } : {}),
    ...(normalized?.operation ? { operation: normalized.operation } : {}),
    ...(normalized?.targetMemoryId ? { targetMemoryIds: [normalized.targetMemoryId] } : {}),
    ...(normalized?.slotKey ? { slotKey: normalized.slotKey } : {}),
    ...(normalized?.title ? { title: normalized.title } : typeof candidate.title === "string" && candidate.title.trim() ? { title: candidate.title.trim().slice(0, 80) } : {}),
    ...(normalized?.content ? { content: normalized.content } : typeof candidate.content === "string" && candidate.content.trim() ? { content: candidate.content.trim().slice(0, 800) } : {}),
    ...(normalized?.kind ? { kind: normalized.kind } : {}),
    reason
  };
}

function findUniqueReplacementTarget(
  candidate: NormalizedExtractionCandidate,
  existingMemories: ContextMemoryFactEntry[]
): ContextMemoryFactEntry | null {
  const normalizedTitle = normalizeTitleForDedup(candidate.title);
  const sameTitleMatches = existingMemories.filter((memory) => normalizeTitleForDedup(memory.title) === normalizedTitle);
  if (sameTitleMatches.length === 1) {
    return sameTitleMatches[0] ?? null;
  }
  if (sameTitleMatches.length > 1) {
    return null;
  }

  const query = `${normalizedTitle} ${candidate.content}`;
  const scored = existingMemories
    .map((memory) => ({
      memory,
      score: bigramJaccardSimilarity(query, `${normalizeTitleForDedup(memory.title)} ${memory.content}`)
    }))
    .filter((item) => item.score >= 0.42)
    .sort((left, right) => right.score - left.score);
  const top = scored[0];
  if (!top) {
    return null;
  }
  const second = scored[1];
  if (second && top.score - second.score < 0.12) {
    return null;
  }
  return top.memory;
}

function parseExtractionResponse(text: string): ExtractionResponse {
  const jsonText = extractJsonPayload(text);
  if (!jsonText) {
    return { items: [] };
  }
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (Array.isArray(parsed)) {
      return { items: parsed.filter(isCandidateObject) };
    }
    if (isRecord(parsed) && Array.isArray(parsed.items)) {
      return { items: parsed.items.filter(isCandidateObject) };
    }
  } catch {
    return { items: [] };
  }
  return { items: [] };
}

function extractJsonPayload(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (candidate.startsWith("{") || candidate.startsWith("[")) {
    return candidate;
  }
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return candidate.slice(objectStart, objectEnd + 1);
  }
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return candidate.slice(arrayStart, arrayEnd + 1);
  }
  return null;
}

function normalizeCandidate(candidate: ExtractionCandidate): NormalizedExtractionCandidate | null {
  const action = candidate.action;
  if (action !== "create" && action !== "replace" && action !== "ignore") {
    return null;
  }
  const scope = normalizeScope(candidate.scope);
  const operation = normalizeOperation(candidate.operation, action);
  const targetMemoryId = normalizeOptionalId(candidate.targetMemoryId ?? candidate.replaceMemoryId);
  const conflictsWithMemoryIds = Array.isArray(candidate.conflictsWithMemoryIds)
    ? candidate.conflictsWithMemoryIds
        .map((id) => normalizeOptionalId(id))
        .filter((id): id is string => id != null)
    : [];
  const slotKey = normalizeSlotKey(candidate.slotKey);
  if (action === "ignore") {
    return {
      action,
      operation,
      scope: scope ?? "user",
      conflictsWithMemoryIds,
      ...(targetMemoryId ? { targetMemoryId } : {}),
      ...(slotKey ? { slotKey } : {}),
      title: "",
      content: "",
      kind: "other",
      importance: 1,
      confidence: 0
    };
  }
  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 80) : "";
  const content = typeof candidate.content === "string" ? candidate.content.trim().slice(0, 800) : "";
  if (!title || !content) {
    return null;
  }
  if (!scope) {
    return null;
  }
  const importance = clampInteger(candidate.importance, 1, 5, 3);
  const confidence = clampNumber(candidate.confidence, 0, 1, 0);
  return {
    action,
    operation,
    scope,
    ...(targetMemoryId ? { targetMemoryId } : {}),
    conflictsWithMemoryIds,
    ...(slotKey ? { slotKey } : {}),
    title,
    content,
    kind: normalizeKind(candidate.kind),
    importance,
    confidence
  };
}

function normalizeOperation(value: unknown, action: ExtractionCandidate["action"]): ExtractionOperation {
  if (value === "noop"
    || value === "create"
    || value === "update_existing"
    || value === "invalidate_and_create"
    || value === "merge"
    || value === "ignore_wrong_scope") {
    return value;
  }
  if (action === "replace") {
    return "update_existing";
  }
  if (action === "ignore") {
    return "noop";
  }
  return "create";
}

function normalizeOptionalId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSlotKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized || normalized.length > 80) {
    return null;
  }
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    const isLowerAscii = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isLowerAscii && !isDigit && char !== "_") {
      return null;
    }
  }
  return normalized;
}

function emptyExtractionResult(): ContextExtractionResult {
  return { created: 0, replaced: 0, ignored: 0, items: [] };
}

function normalizeScope(value: unknown): ContextScope | null {
  return value === "session"
    || value === "user"
    || value === "global"
    || value === "toolset"
    || value === "mode"
    ? value
    : null;
}

function buildSessionFactValidTo(config: AppConfig, now: number): number {
  return now + config.context.retention.sessionFactRetentionDays * 24 * 60 * 60 * 1000;
}

function normalizeKind(value: unknown): UserMemoryKind {
  return value === "preference"
    || value === "fact"
    || value === "boundary"
    || value === "habit"
    || value === "relationship"
    || value === "other"
    ? value
    : "other";
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value as number)))
    : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value as number))
    : fallback;
}

function isCandidateObject(value: unknown): value is ExtractionCandidate {
  return isRecord(value) && typeof value.action === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

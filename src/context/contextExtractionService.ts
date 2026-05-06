import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { bigramJaccardSimilarity, isNearDuplicateText, normalizeTitleForDedup } from "#memory/similarity.ts";
import type { UserMemoryEntry, UserMemoryKind } from "#memory/userMemoryEntry.ts";
import type { ContextStore } from "./contextStore.ts";
import type { ContextScope } from "./contextTypes.ts";

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
  scope?: ContextScope;
  replaceMemoryId?: string;
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
}

type ContextExtractionStore = Pick<ContextStore, "listUserFacts" | "upsertUserFact" | "listSessionFacts" | "upsertSessionFact">;
type NormalizedExtractionCandidate = Required<Omit<ExtractionCandidate, "replaceMemoryId" | "scope">> & {
  scope: ContextScope;
  replaceMemoryId?: string;
};
type ScopedMemoryEntry = UserMemoryEntry & { scope: "user" | "session" };

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
      return { created: 0, replaced: 0, ignored: 0 };
    }
    try {
      const targetUserMessages = input.turns.flatMap((turn) => (
        turn.userMessages.filter((message) => message.userId === input.userId && message.text.trim().length > 0)
      ));
      if (targetUserMessages.length === 0) {
        return { created: 0, replaced: 0, ignored: 0 };
      }
      const currentTurnMessages = input.turns.flatMap((turn) => (
        turn.userMessages.filter((message) => message.text.trim().length > 0)
      ));
      const conversationText = currentTurnMessages.map((message) => message.text.trim()).join("\n").trim();
      if (!conversationText) {
        return { created: 0, replaced: 0, ignored: 0 };
      }

      const modelRefs = getModelRefsForRole(this.config, "summarizer");
      if (!this.llmClient.isConfigured(modelRefs)) {
        this.logger.warn({
          sessionId: input.sessionId,
          userId: input.userId,
          modelRefs
        }, "context_extraction_skipped_llm_unconfigured");
        return { created: 0, replaced: 0, ignored: 0 };
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
      return { created: 0, replaced: 0, ignored: 0 };
    }
  }

  private applyCandidates(input: {
    userId: string;
    sessionId: string;
    candidates: ExtractionCandidate[];
    existingMemories: UserMemoryEntry[];
    existingSessionMemories: UserMemoryEntry[];
    minConfidence: number;
  }): ContextExtractionResult {
    let created = 0;
    let replaced = 0;
    let ignored = 0;
    const existingById = new Map(input.existingMemories.map((item) => [item.id, item]));
    const existingSessionById = new Map(input.existingSessionMemories.map((item) => [item.id, item]));
    const acceptedTexts: string[] = input.existingMemories.map((item) => `${item.title}\n${item.content}`);
    const acceptedSessionTexts: string[] = input.existingSessionMemories.map((item) => `${item.title}\n${item.content}`);

    for (const candidate of input.candidates) {
      const normalized = normalizeCandidate(candidate);
      if (!normalized || normalized.confidence < input.minConfidence || normalized.action === "ignore") {
        ignored += 1;
        continue;
      }
      if (normalized.scope !== "user" && normalized.scope !== "session") {
        ignored += 1;
        continue;
      }
      const memoryText = `${normalized.title}\n${normalized.content}`;
      const scopeMemories = normalized.scope === "session" ? input.existingSessionMemories : input.existingMemories;
      const scopeExistingById = normalized.scope === "session" ? existingSessionById : existingById;
      const replacementTarget = resolveReplacementTarget(normalized, scopeMemories, scopeExistingById);
      const replacingExisting = replacementTarget != null;
      if (normalized.action === "replace" && !replacementTarget) {
        ignored += 1;
        continue;
      }
      const acceptedScopeTexts = normalized.scope === "session" ? acceptedSessionTexts : acceptedTexts;
      if (!replacingExisting && isNearDuplicateText(memoryText, acceptedScopeTexts)) {
        ignored += 1;
        continue;
      }

      try {
        const now = Date.now();
        const result = normalized.scope === "session"
          ? this.contextStore.upsertSessionFact({
              sessionId: input.sessionId,
              ...(replacementTarget ? { memoryId: replacementTarget.id } : {}),
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
              ...(replacementTarget ? { memoryId: replacementTarget.id } : {}),
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
        acceptedScopeTexts.push(memoryText);
      } catch (error) {
        ignored += 1;
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
    return { created, replaced, ignored };
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

function scoreRelatedMemory(memory: UserMemoryEntry, queryText: string): number {
  const text = `${memory.title}\n${memory.content}`;
  const normalizedTitle = normalizeTitleForDedup(memory.title);
  let score = isNearDuplicateText(queryText, [text], 0.42) ? 2 : 0;
  if (normalizedTitle && queryText.includes(normalizedTitle)) {
    score += 2;
  }
  for (const term of ["早餐", "称呼", "口吻", "时区", "职业", "工作", "城市", "边界", "偏好"]) {
    if (queryText.includes(term) && text.includes(term)) {
      score += 1;
    }
  }
  return score;
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
        "判定示例：用户说“以后所有任务默认先列三步计划。”，应输出 {\"items\":[{\"action\":\"ignore\",\"scope\":\"global\",\"confidence\":1}]}，绝不能写成 user 偏好。",
        "判定示例：用户说“以后请叫我阿明。”，应输出 scope=user 的 create。",
        "判定示例：用户说“此会话专门用于记忆系统测试。”，应输出 scope=session 的 create。",
        "判定示例：用户说“帮我临时算一下 37 加 58。”，应输出 {\"items\":[]}。",
        "如果用户明确更正或改变旧信息，输出 replace，并优先使用 related_memories 中对应的 replaceMemoryId。",
        "如果没有值得长期保存的信息，输出 {\"items\":[]}。",
        "只输出 JSON，不要解释。JSON 格式：{\"items\":[{\"action\":\"create|replace|ignore\",\"scope\":\"user|session|global|toolset|mode\",\"replaceMemoryId\":\"可选\",\"title\":\"短标题\",\"content\":\"完整记忆内容\",\"kind\":\"preference|fact|boundary|habit|relationship|other\",\"importance\":1-5,\"confidence\":0-1}]}"
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
  existingMemories: UserMemoryEntry[],
  existingById: Map<string, UserMemoryEntry>
): UserMemoryEntry | null {
  if (candidate.action !== "replace") {
    return null;
  }
  if (candidate.replaceMemoryId) {
    return existingById.get(candidate.replaceMemoryId) ?? null;
  }
  return findUniqueReplacementTarget(candidate, existingMemories);
}

function findUniqueReplacementTarget(
  candidate: NormalizedExtractionCandidate,
  existingMemories: UserMemoryEntry[]
): UserMemoryEntry | null {
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
  if (action === "ignore") {
    return {
      action,
      scope: scope ?? "user",
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
    scope,
    ...(typeof candidate.replaceMemoryId === "string" && candidate.replaceMemoryId.trim()
      ? { replaceMemoryId: candidate.replaceMemoryId.trim() }
      : {}),
    title,
    content,
    kind: normalizeKind(candidate.kind),
    importance,
    confidence
  };
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

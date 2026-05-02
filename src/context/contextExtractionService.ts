import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { bigramJaccardSimilarity, isNearDuplicateText, normalizeTitleForDedup } from "#memory/similarity.ts";
import type { UserMemoryEntry, UserMemoryKind } from "#memory/userMemoryEntry.ts";
import type { ContextStore } from "./contextStore.ts";

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

type ContextExtractionStore = Pick<ContextStore, "listUserFacts" | "upsertUserFact">;
type NormalizedExtractionCandidate = Required<Omit<ExtractionCandidate, "replaceMemoryId">> & {
  replaceMemoryId?: string;
};

const LOW_SIGNAL_ASSISTANT_PATTERN = /^(好的|好|收到|明白|了解|记下了|已记下|已更新|ok|OK)[。.!！\s]*$/u;
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
      const targetUserText = targetUserMessages.map((message) => message.text.trim()).join("\n").trim();
      const relatedMemories = selectRelatedMemories(
        existingMemories,
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
    minConfidence: number;
  }): ContextExtractionResult {
    let created = 0;
    let replaced = 0;
    let ignored = 0;
    const existingById = new Map(input.existingMemories.map((item) => [item.id, item]));
    const acceptedTexts: string[] = input.existingMemories.map((item) => `${item.title}\n${item.content}`);

    for (const candidate of input.candidates) {
      const normalized = normalizeCandidate(candidate);
      if (!normalized || normalized.confidence < input.minConfidence || normalized.action === "ignore") {
        ignored += 1;
        continue;
      }
      const memoryText = `${normalized.title}\n${normalized.content}`;
      const replacementTarget = resolveReplacementTarget(normalized, input.existingMemories, existingById);
      const replacingExisting = replacementTarget != null;
      if (normalized.action === "replace" && !replacementTarget) {
        ignored += 1;
        continue;
      }
      if (!replacingExisting && isNearDuplicateText(memoryText, acceptedTexts)) {
        ignored += 1;
        continue;
      }

      try {
        const result = this.contextStore.upsertUserFact({
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
        acceptedTexts.push(memoryText);
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
  memories: UserMemoryEntry[],
  queryText: string,
  limit: number
): UserMemoryEntry[] {
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
  relatedMemories: UserMemoryEntry[];
}): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是聊天记忆抽取器，只负责判断当前轮对话是否需要更新当前用户的长期记忆。",
        "输入会包含当前 debounce batch 的完整对话；你只能为 target_user_id 对应用户抽取记忆。",
        "群聊中其他人的话只作为上下文，不要把其他群成员的信息写到 target_user_id 身上。",
        "只记录稳定、长期可复用的信息：称呼、身份、职业、所在地、时区、长期偏好、长期习惯、明确边界、关系备注。",
        "不要记录一次性任务、临时状态、当前正在做的事、闲聊、问题本身、助手猜测、助手为了本轮任务做出的总结。",
        "如果用户明确更正或改变旧信息，输出 replace，并优先使用 related_memories 中对应的 replaceMemoryId。",
        "如果没有值得长期保存的信息，输出 {\"items\":[]}。",
        "只输出 JSON，不要解释。JSON 格式：{\"items\":[{\"action\":\"create|replace|ignore\",\"replaceMemoryId\":\"可选\",\"title\":\"短标题\",\"content\":\"完整记忆内容\",\"kind\":\"preference|fact|boundary|habit|relationship|other\",\"importance\":1-5,\"confidence\":0-1}]}"
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
          .filter((text) => text.length > 0 && !LOW_SIGNAL_ASSISTANT_PATTERN.test(text)),
        related_memories: input.relatedMemories.map((memory) => ({
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
  if (action === "ignore") {
    return {
      action,
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
  const importance = clampInteger(candidate.importance, 1, 5, 3);
  const confidence = clampNumber(candidate.confidence, 0, 1, 0);
  return {
    action,
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

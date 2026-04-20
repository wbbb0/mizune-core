import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SessionTitleSource } from "#conversation/session/sessionTypes.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { getMainModelRefsForTier } from "#llm/shared/modelProfiles.ts";
import { createSessionTitleGenerationEvent } from "#conversation/session/internalTranscriptEvents.ts";

export interface SessionCaptioningAccess {
  getSession(sessionId: string): SessionState;
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  setTitle(sessionId: string, title: string, titleSource: SessionTitleSource): SessionState;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
}

export interface SessionCaptionerInput {
  sessionId: string;
  modeId: string;
  historySummary: string | null;
  history: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
}

export class SessionCaptioner {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly logger: Logger
  ) {}

  async generateTitle(input: SessionCaptionerInput): Promise<string | null> {
    const modelRefs = getMainModelRefsForTier(this.config, "small");
    if (modelRefs.length === 0 || !this.llmClient.isConfigured(modelRefs)) {
      return null;
    }

    const recentHistory = input.history.slice(-8);
    const userLines = [
      `会话模式：${input.modeId}`,
      input.historySummary ? `历史摘要：${input.historySummary}` : "历史摘要：无",
      recentHistory.length > 0
        ? ["最近消息：", ...recentHistory.map((item) => `- ${item.role === "assistant" ? "助手" : "用户"}：${item.content}`)]
        : ["最近消息：无"]
    ].flat().join("\n");

    try {
      const result = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        enableThinkingOverride: false,
        timeoutMsOverride: 15_000,
        messages: [
          {
            role: "system",
            content: [
              "你是会话标题生成器。",
              "根据会话模式、历史摘要和最近消息，为当前会话生成一个简短、准确、易懂的标题。",
              "要求：",
              "1. 只输出标题本身，不要解释。",
              "2. 不要输出引号、编号、前缀或结尾标点。",
              "3. 优先使用中文，长度尽量控制在 24 个汉字以内。",
              "4. 如果信息不足，请输出空字符串。"
            ].join("\n")
          },
          {
            role: "user",
            content: userLines
          }
        ]
      });
      return normalizeCaptionTitle(result.text);
    } catch (error: unknown) {
      this.logger.warn(
        {
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error)
        },
        "session_title_caption_failed"
      );
      return null;
    }
  }
}

export async function maybeAutoCaptionSessionTitle(input: {
  sessionId: string;
  sessionManager: SessionCaptioningAccess;
  sessionCaptioner: SessionCaptioner;
  persistSession?: (sessionId: string, reason: string) => void;
  logger?: Logger;
  reason: string;
}): Promise<boolean> {
  const session = input.sessionManager.getSession(input.sessionId);
  if (session.source !== "web" || session.titleSource === "manual") {
    return false;
  }

  const history = input.sessionManager.getLlmVisibleHistory(input.sessionId);
  if (history.length === 0 && !String(session.historySummary ?? "").trim()) {
    return false;
  }

  const title = await input.sessionCaptioner.generateTitle({
    sessionId: input.sessionId,
    modeId: session.modeId,
    historySummary: session.historySummary,
    history
  });
  if (!title) {
    return false;
  }

  if (session.title === title && session.titleSource === "auto") {
    return false;
  }

  input.sessionManager.setTitle(input.sessionId, title, "auto");
  input.sessionManager.appendInternalTranscript(input.sessionId, createSessionTitleGenerationEvent({
    source: "auto",
    modeId: session.modeId,
    title,
    summary: title,
    details: [
      `sessionId: ${input.sessionId}`,
      `modeId: ${session.modeId}`,
      `historySummary: ${String(session.historySummary ?? "").trim() || "(none)"}`,
      `historyCount: ${history.length}`
    ].join("\n")
  }));
  input.persistSession?.(input.sessionId, input.reason);
  input.logger?.info(
    {
      sessionId: input.sessionId,
      title,
      reason: input.reason
    },
    "session_title_auto_captioned"
  );
  return true;
}

function normalizeCaptionTitle(value: string): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^[「『【“"'\s]+/, "")
    .replace(/[」』】”"'\s。．.?!！?]+$/, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const sliced = normalized.slice(0, 24).trim();
  return sliced || null;
}

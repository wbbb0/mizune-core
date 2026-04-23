import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SessionTitleSource } from "#conversation/session/sessionTypes.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { createSessionTitleGenerationEvent } from "#conversation/session/internalTranscriptEvents.ts";

export interface SessionCaptioningAccess {
  getSession(sessionId: string): SessionState;
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  setTitle(sessionId: string, title: string, titleSource: SessionTitleSource): SessionState;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
}

export function shouldAutoCaptionSessionTitle(
  session: Pick<SessionState, "source" | "titleSource">,
  options?: {
    forceRegenerate?: boolean | undefined;
  }
): boolean {
  if (session.source !== "web") {
    return false;
  }

  if (session.titleSource === "manual") {
    return false;
  }

  if (options?.forceRegenerate) {
    return session.titleSource === "default" || session.titleSource === "auto";
  }

  return session.titleSource === "default";
}

export interface SessionCaptionerInput {
  sessionId: string;
  modeId: string;
  reason: "turn_auto" | "manual_regenerate" | "scenario_setup";
  historySummary: string | null;
  history: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  scenarioState?: ScenarioHostSessionState | null | undefined;
}

export class SessionCaptioner {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly logger: Logger
  ) {}

  isAvailable(): boolean {
    const modelRefs = this.getCaptionerModelRefs();
    return modelRefs.length > 0 && this.llmClient.isConfigured(modelRefs);
  }

  async generateTitle(input: SessionCaptionerInput): Promise<string | null> {
    const captionerConfig = this.config.llm.sessionCaptioner;
    const modelRefs = this.getCaptionerModelRefs();
    if (modelRefs.length === 0 || !this.llmClient.isConfigured(modelRefs)) {
      return null;
    }
    const prompt = buildSessionCaptionPrompt(input);

    try {
      const result = await this.llmClient.generate({
        modelRefOverride: modelRefs,
        enableThinkingOverride: captionerConfig.enableThinking,
        timeoutMsOverride: captionerConfig.timeoutMs,
        messages: [
          {
            role: "system",
            content: prompt.system
          },
          {
            role: "user",
            content: prompt.user
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

  private getCaptionerModelRefs(): string[] {
    const captionerConfig = this.config.llm.sessionCaptioner;
    if (!captionerConfig.enabled) {
      return [];
    }
    return getModelRefsForRole(this.config, "session_captioner");
  }
}

export async function maybeAutoCaptionSessionTitle(input: {
  sessionId: string;
  sessionManager: SessionCaptioningAccess;
  sessionCaptioner: SessionCaptioner;
  expectedHistoryRevision?: number;
  forceRegenerate?: boolean;
  persistSession?: (sessionId: string, reason: string) => void;
  logger?: Logger;
  reason: string;
}): Promise<boolean> {
  const session = input.sessionManager.getSession(input.sessionId);
  if (!shouldAutoCaptionSessionTitle(session, { forceRegenerate: input.forceRegenerate })) {
    return false;
  }
  if (input.expectedHistoryRevision != null && session.historyRevision !== input.expectedHistoryRevision) {
    return false;
  }
  if (!input.sessionCaptioner.isAvailable()) {
    return false;
  }

  const history = input.sessionManager.getLlmVisibleHistory(input.sessionId);
  if (history.length === 0 && !String(session.historySummary ?? "").trim()) {
    return false;
  }

  const title = await input.sessionCaptioner.generateTitle({
    sessionId: input.sessionId,
    modeId: session.modeId,
    reason: "turn_auto",
    historySummary: session.historySummary,
    history
  });
  if (!title) {
    return false;
  }

  const currentSession = input.sessionManager.getSession(input.sessionId);
  if (!shouldAutoCaptionSessionTitle(currentSession, { forceRegenerate: input.forceRegenerate })) {
    return false;
  }
  if (input.expectedHistoryRevision != null && currentSession.historyRevision !== input.expectedHistoryRevision) {
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

function buildSessionCaptionPrompt(input: SessionCaptionerInput): { system: string; user: string } {
  if (input.reason === "scenario_setup") {
    return buildScenarioSetupCaptionPrompt(input);
  }
  return buildDefaultSessionCaptionPrompt(input);
}

function buildDefaultSessionCaptionPrompt(input: SessionCaptionerInput): { system: string; user: string } {
  const recentHistory = input.history.slice(-8);
  return {
    system: [
      "你是会话标题生成器。",
      "根据会话模式、历史摘要和最近消息，为当前会话生成一个简短、准确、易懂的标题。",
      "要求：",
      "1. 只输出标题本身，不要解释。",
      "2. 不要输出引号、编号、前缀或结尾标点。",
      "3. 优先使用中文，长度尽量控制在 24 个汉字以内。",
      "4. 如果信息不足，请输出空字符串。"
    ].join("\n"),
    user: [
      `会话模式：${input.modeId}`,
      input.historySummary ? `历史摘要：${input.historySummary}` : "历史摘要：无",
      recentHistory.length > 0
        ? ["最近消息：", ...recentHistory.map((item) => `- ${item.role === "assistant" ? "助手" : "用户"}：${item.content}`)]
        : ["最近消息：无"]
    ].flat().join("\n")
  };
}

function buildScenarioSetupCaptionPrompt(input: SessionCaptionerInput): { system: string; user: string } {
  const state = input.scenarioState;
  const objectiveLine = state && state.objectives.length > 0
    ? state.objectives
      .filter((item) => item.status === "active")
      .map((item) => `${item.title}：${item.summary}`.replace(/：$/, ""))
      .filter(Boolean)
      .join("；")
    : "";

  return {
    system: [
      "你是 scenario_host 会话的场景标题生成器。",
      "你要为刚完成 setup 的当前情景生成一个位置与当前局势导向的短标题。",
      "标题应像场景卡片名，不像小说名、章节名或文艺标题。",
      "要求：",
      "1. 只输出标题本身，不要解释。",
      "2. 优先体现当前位置和当前局势/阶段。",
      "3. 风格简洁、描述性强，避免夸张和抒情。",
      "4. 优先使用中文，长度尽量控制在 24 个汉字以内。",
      "5. 如果信息不足，请输出空字符串。"
    ].join("\n"),
    user: [
      `会话模式：${input.modeId}`,
      `生成原因：${input.reason}`,
      `当前位置：${String(state?.currentLocation ?? "").trim() || "未提供"}`,
      `当前局势：${String(state?.currentSituation ?? "").trim() || "未提供"}`,
      `场景摘要：${String(state?.sceneSummary ?? "").trim() || "未提供"}`,
      `当前目标：${objectiveLine || "未提供"}`,
      state?.worldFacts?.length ? `关键事实：${state.worldFacts.join("；")}` : "关键事实：未提供"
    ].join("\n")
  };
}

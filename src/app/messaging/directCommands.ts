import type { Logger } from "pino";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { AppConfig } from "#config/config.ts";
import type { SessionCaptioner } from "#app/generation/sessionCaptioner.ts";
import { getDefaultMainModelRefs, getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import type { SessionDirectCommandAccess } from "#conversation/session/sessionCapabilities.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { InternalTranscriptItem, SessionState } from "#conversation/session/sessionTypes.ts";
import { requireSessionModeDefinition } from "#modes/registry.ts";
import type { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";
import type { ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { createInitialScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { createSessionTitleGenerationEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { resolveSessionParticipantLabel } from "#conversation/session/sessionIdentity.ts";
import { parseOwnerBootstrapCommand } from "#app/bootstrap/ownerBootstrapPolicy.ts";

type DebugModeArg = "on" | "off" | "once" | "status";

type DirectCommandArgsMap = {
  clear: {};
  help: {};
  status: {};
  context: {};
  retract: { count?: number };
  stop: {};
  own: { userId?: string };
  compact: { keep?: number };
  debug: { mode?: DebugModeArg; inlineText?: string };
  reset: {};
  confirm: {};
};

export type DirectCommandName = keyof DirectCommandArgsMap;
export type ParsedDirectCommand = {
  [Name in DirectCommandName]: { name: Name } & DirectCommandArgsMap[Name];
}[DirectCommandName];
export interface UnknownDirectCommand {
  name: "unknown";
  rawText: string;
}
export type ResolvedDirectCommand = ParsedDirectCommand | UnknownDirectCommand;

interface DirectCommandIncomingMessage {
  channelId?: string;
  chatType: "private" | "group";
  userId: string;
  externalUserId?: string;
  groupId?: string;
  relationship?: Relationship;
}

interface DirectCommandHandlerInput {
  config: AppConfig;
  sessionManager: SessionDirectCommandAccess;
  oneBotClient: OneBotClient;
  logger: Logger;
  sessionCaptioner?: SessionCaptioner;
  scenarioHostStateStore?: ScenarioHostStateStore;
  forceCompactSession?: (sessionId: string, retainMessageCount?: number) => Promise<boolean>;
  flushSession?: (sessionId: string, options?: { skipReplyGate?: boolean }) => void;
  persistSession: (sessionId: string, reason: string) => void;
  sendImmediateText: (params: {
    sessionId: string;
    userId: string;
    groupId?: string;
    text: string;
    recordInHistory?: boolean;
    transcriptItem?: InternalTranscriptItem;
    recordForRetract?: boolean;
    autoRetractAfterMs?: number;
  }) => Promise<void>;
  isOwnerAssignmentAvailable?: () => Promise<boolean>;
  assignOwner?: (params: {
    channelId: string;
    requesterUserId: string;
    targetUserId: string;
    sessionId: string;
    chatType: "private" | "group";
  }) => Promise<string>;
}

interface DirectCommandExecutionContext {
  input: DirectCommandHandlerInput;
  session: SessionState;
  incomingMessage: DirectCommandIncomingMessage;
  ownerAssignmentAvailable: boolean;
  send: (text: string) => Promise<void>;
  commandName: ResolvedDirectCommand["name"];
}

interface DirectCommandRoutingContext {
  phase: "owner_bootstrap" | "chat";
  setupState: "needs_owner" | "needs_persona" | "ready";
  chatType: "private" | "group";
  relationship?: Relationship;
  isAtMentioned?: boolean;
  sessionModeId?: string;
}

interface DirectCommandDispatchContext extends DirectCommandRoutingContext {
  text: string;
  hasImages?: boolean;
  hasForwards?: boolean;
  hasAudio?: boolean;
}

interface DirectCommandDescriptor {
  name: DirectCommandName;
  scope?: "universal" | string;
  help: string;
  dispatch?: {
    requireTextOnly?: boolean;
  };
  routing?: {
    allowBeforeOwnerBound?: boolean;
    allowInPrivate?: boolean;
    allowInOwnerMentionedGroup?: boolean;
  };
  parse: (text: string) => ParsedDirectCommand | null;
  access?: (ctx: DirectCommandExecutionContext) => string | null;
  execute: (ctx: DirectCommandExecutionContext, command: ParsedDirectCommand) => Promise<void>;
}

function formatTokenCount(value: number | null): string {
  return value == null ? "provider 未返回" : String(value);
}

function formatOptionalUsageDetail(value: number | null, providerReported: boolean): string {
  if (value != null) {
    return String(value);
  }
  return providerReported ? "0" : "provider 未返回";
}

function requireOwner(ctx: DirectCommandExecutionContext): string | null {
  return ctx.incomingMessage.relationship === "owner"
    ? null
    : "只有 owner 可以切换调试模式。";
}

function appendDebugMarker(
  ctx: DirectCommandExecutionContext,
  marker: {
    kind: "debug_enabled" | "debug_disabled" | "debug_once_armed" | "debug_once_consumed";
    note: string;
  }
): void {
  ctx.input.sessionManager.appendDebugMarker(ctx.session.id, {
    kind: marker.kind,
    timestampMs: Date.now(),
    note: marker.note
  });
  ctx.input.persistSession(ctx.session.id, marker.kind);
}

function triggerInlineDebugOnce(ctx: DirectCommandExecutionContext, inlineText: string): void {
  if (!ctx.input.flushSession) {
    throw new Error("flushSession is required for inline .debug once");
  }
  const now = Date.now();
  ctx.input.sessionManager.appendSyntheticPendingMessage(ctx.session.id, {
    chatType: ctx.incomingMessage.chatType,
    userId: ctx.incomingMessage.userId,
    ...(ctx.incomingMessage.groupId ? { groupId: ctx.incomingMessage.groupId } : {}),
    senderName: ctx.incomingMessage.userId,
    text: inlineText,
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    attachments: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false
  });
  ctx.input.sessionManager.appendUserHistory(
    ctx.session.id,
    {
      chatType: ctx.incomingMessage.chatType,
      userId: ctx.incomingMessage.userId,
      senderName: ctx.incomingMessage.userId,
      text: inlineText
    },
    now
  );
  appendDebugMarker(ctx, {
    kind: "debug_once_consumed",
    note: "inline_debug_once_triggered"
  });
  ctx.input.persistSession(ctx.session.id, "inline_debug_once_enqueued");
  ctx.input.flushSession(ctx.session.id, { skipReplyGate: true });
}

async function maybeCaptionScenarioSetupTitle(
  ctx: DirectCommandExecutionContext,
  scenarioState: ScenarioHostSessionState
): Promise<void> {
  if (ctx.session.modeId !== "scenario_host") {
    return;
  }
  if (ctx.session.source !== "web") {
    return;
  }
  if (ctx.session.titleSource === "manual") {
    return;
  }
  if (!ctx.input.sessionCaptioner?.isAvailable()) {
    return;
  }

  const title = await ctx.input.sessionCaptioner.generateTitle({
    sessionId: ctx.session.id,
    modeId: ctx.session.modeId,
    reason: "scenario_setup",
    historySummary: ctx.session.historySummary,
    history: ctx.input.sessionManager.getLlmVisibleHistory(ctx.session.id),
    scenarioState
  });
  if (!title) {
    return;
  }

  ctx.input.sessionManager.setTitle(ctx.session.id, title, "auto");
  ctx.input.sessionManager.appendInternalTranscript(ctx.session.id, createSessionTitleGenerationEvent({
    source: "auto",
    modeId: ctx.session.modeId,
    title,
    summary: title,
    details: [
      `sessionId: ${ctx.session.id}`,
      "captionReason: scenario_setup",
      `location: ${String(scenarioState.currentLocation ?? "").trim() || "(none)"}`,
      `situation: ${String(scenarioState.currentSituation ?? "").trim() || "(none)"}`
    ].join("\n")
  }));
  ctx.input.persistSession(ctx.session.id, "scenario_setup_title_captioned");
}

const directCommandDescriptors: DirectCommandDescriptor[] = [
  {
    name: "help",
    help: ".help 查看帮助",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      return /^[。.]\s*help\s*$/i.test(text)
        ? { name: "help" }
        : null;
    },
    async execute(ctx: DirectCommandExecutionContext) {
      const lines = [
        "可用指令：",
        ...directCommandDescriptors.map((descriptor) => descriptor.help)
      ];
      await ctx.send(lines.join("\n"));
    }
  },
  {
    name: "status",
    help: ".status 查看当前会话状态",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      return /^[。.]\s*status\s*$/i.test(text)
        ? { name: "status" }
        : null;
    },
    async execute(ctx: DirectCommandExecutionContext) {
      const usage = ctx.session.lastLlmUsage;
      const statusModelRef = usage?.modelRef ?? getDefaultMainModelRefs(ctx.input.config);
      const statusModelProfile = getPrimaryModelProfile(ctx.input.config, statusModelRef);
      const debugState = ctx.input.sessionManager.getDebugControlState(ctx.session.id);
      const llmVisibleHistory = ctx.input.sessionManager.getLlmVisibleHistory(ctx.session.id);
      await ctx.send([
        `会话 ID：${ctx.session.id}`,
        `会话类型：${ctx.session.type}`,
        `调试模式：常驻=${debugState.enabled ? "开" : "关"}；单次=${debugState.oncePending ? "待触发" : "无"}`,
        `正在生成：${ctx.input.sessionManager.isGenerating(ctx.session.id) ? "是" : "否"}`,
        `待处理消息：${ctx.session.pendingMessages.length}`,
        `最近历史条数：${llmVisibleHistory.length}`,
        `已有摘要：${ctx.session.historySummary ? "有" : "无"}`,
        `Provider：${statusModelProfile?.provider ?? "unknown"}`,
        `模型：${usage?.model ?? statusModelProfile?.model ?? "unknown"}`
      ].join("\n"));
    }
  },
  {
    name: "context",
    help: ".context 查看上一次模型请求的 token 统计",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      return /^[。.]\s*context\s*$/i.test(text)
        ? { name: "context" }
        : null;
    },
    async execute(ctx: DirectCommandExecutionContext) {
      const usage = ctx.session.lastLlmUsage;
      const llmVisibleHistory = ctx.input.sessionManager.getLlmVisibleHistory(ctx.session.id);
      if (!usage) {
        await ctx.send("当前会话还没有可用的上下文 token 统计。");
        return;
      }
      await ctx.send([
        `会话 ID：${ctx.session.id}`,
        `消息窗口条数：${llmVisibleHistory.length}`,
        `摘要字符数：${ctx.session.historySummary?.length ?? 0}`,
        `可撤回消息数：${ctx.session.sentMessages.filter((item) => Date.now() - item.sentAt <= 120000).length}`,
        `模型引用：${usage.modelRef ?? "unknown"}`,
        `模型：${usage.model ?? "unknown"}`,
        `输入 tokens：${formatTokenCount(usage.inputTokens)}`,
        `缓存命中 tokens：${formatOptionalUsageDetail(usage.cachedTokens, usage.providerReported)}`,
        `思考 tokens：${formatOptionalUsageDetail(usage.reasoningTokens, usage.providerReported)}`,
        `输出 tokens：${formatTokenCount(usage.outputTokens)}`,
        `总 tokens：${formatTokenCount(usage.totalTokens)}`,
        `累计请求次数：${usage.requestCount}`,
        `provider usage：${usage.providerReported ? "已返回" : "未返回"}`,
        `记录时间：${new Date(usage.capturedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`
      ].join("\n"));
    }
  },
  {
    name: "stop",
    help: ".stop 强行停止当前回答生成",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      return /^[。.]\s*stop\s*$/i.test(text)
        ? { name: "stop" }
        : null;
    },
    async execute(ctx: DirectCommandExecutionContext) {
      const cancelled = ctx.input.sessionManager.cancelGeneration(ctx.session.id);
      ctx.input.persistSession(ctx.session.id, cancelled ? "generation_stopped_by_command" : "generation_stop_command_noop");
      ctx.input.logger.info({ sessionId: ctx.session.id, cancelled }, "generation_stop_requested_by_command");
      await ctx.send(cancelled ? "已强行停止当前回答生成。" : "当前没有正在进行的回答生成。");
    }
  },
  {
    name: "clear",
    help: ".clear 清空当前会话上下文",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      return /^[。.]\s*clear\s*$/i.test(text)
        ? { name: "clear" }
        : null;
    },
    async execute(ctx: DirectCommandExecutionContext) {
      const cancelled = ctx.input.sessionManager.cancelGeneration(ctx.session.id);
      ctx.input.sessionManager.clearSession(ctx.session.id);
      ctx.input.persistSession(ctx.session.id, "session_cleared");
      ctx.input.logger.info({ sessionId: ctx.session.id, cancelled }, "session_cleared_by_command");
      await ctx.send("当前会话上下文已清空。");
    }
  },
  {
    name: "compact",
    help: ".compact [保留条数] 强制压缩当前会话历史；不带参数时使用默认保留长度",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      const match = text.match(/^[。.]\s*compact(?:\s+(\d+))?\s*$/i);
      if (!match) {
        return null;
      }
      const rawKeep = match[1];
      return rawKeep == null
        ? { name: "compact" }
        : { name: "compact", keep: Math.max(0, Number(rawKeep)) };
    },
    async execute(ctx: DirectCommandExecutionContext, command: ParsedDirectCommand) {
      if (!ctx.input.forceCompactSession) {
        await ctx.send("当前实例未启用手动历史压缩。");
        return;
      }
      const compactCommand = command as Extract<ParsedDirectCommand, { name: "compact" }>;
      const cancelled = ctx.input.sessionManager.cancelGeneration(ctx.session.id);
      const compacted = await ctx.input.forceCompactSession(ctx.session.id, compactCommand.keep);
      ctx.input.persistSession(ctx.session.id, compacted ? "session_compacted" : "session_compact_noop");
      ctx.input.logger.info({ sessionId: ctx.session.id, cancelled, compacted }, "session_compacted_by_command");
      await ctx.send(compacted ? "当前会话历史已强制压缩。" : "当前会话历史不足，无需压缩。");
    }
  },
  {
    name: "retract",
    help: ".retract [数量] 撤回最近发出的消息",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      const match = text.match(/^[。.]\s*retract(?:\s+(\d+))?\s*$/i);
      if (!match) {
        return null;
      }
      const rawCount = match[1];
      const count = rawCount ? Math.max(1, Math.min(20, Number(rawCount))) : 1;
      return { name: "retract", count };
    },
    async execute(ctx: DirectCommandExecutionContext, command: ParsedDirectCommand) {
      const retractCommand = command as Extract<ParsedDirectCommand, { name: "retract" }>;
      const targets = ctx.input.sessionManager.popRetractableSentMessages(
        ctx.session.id,
        retractCommand.count ?? 1,
        120000
      );
      for (const item of targets) {
        try {
          await ctx.input.oneBotClient.deleteMessage(item.messageId);
        } catch (error: unknown) {
          ctx.input.logger.warn({ error, sessionId: ctx.session.id, messageId: item.messageId }, "retract_failed_ignored");
        }
      }
      ctx.input.persistSession(ctx.session.id, "messages_retracted");
      ctx.input.logger.info(
          {
            sessionId: ctx.session.id,
            requestedCount: retractCommand.count ?? 1,
            retractedCount: targets.length
          },
          "direct_retract_completed"
      );
    }
  },
  {
    name: "own",
    help: ".own [userId] 在初始化阶段绑定 owner；不带参数时绑定自己",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowBeforeOwnerBound: true,
      allowInPrivate: true,
      allowInOwnerMentionedGroup: false
    },
    parse(text: string): ParsedDirectCommand | null {
      const command = parseOwnerBootstrapCommand(text);
      if (!command) {
        return null;
      }
      return {
        name: "own",
        ...(command.userId ? { userId: command.userId } : {})
      };
    },
    async execute(ctx: DirectCommandExecutionContext, command: ParsedDirectCommand) {
      const ownCommand = command as Extract<ParsedDirectCommand, { name: "own" }>;
      if (!ctx.input.assignOwner || !ctx.ownerAssignmentAvailable) {
        await ctx.send("当前实例已完成初始化，.own 不再可用。");
        return;
      }
      const result = await ctx.input.assignOwner({
        channelId: ctx.incomingMessage.channelId ?? "qqbot",
        requesterUserId: ctx.incomingMessage.externalUserId ?? ctx.incomingMessage.userId,
        targetUserId: ownCommand.userId?.trim() || ctx.incomingMessage.externalUserId || ctx.incomingMessage.userId,
        sessionId: ctx.session.id,
        chatType: ctx.incomingMessage.chatType
      });
      await ctx.send(result);
    }
  },
  {
    name: "debug",
    help: ".debug [on|off|once [文本]|status] 切换或查看当前会话调试模式",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: true
    },
    parse(text: string): ParsedDirectCommand | null {
      const match = text.match(/^[。.]\s*debug(?:\s+(on|off|once|status)(?:\s+(.+))?)?\s*$/i);
      if (!match) {
        return null;
      }
      const mode = ((match[1] ?? "status").toLowerCase() as DebugModeArg);
      const inlineText = typeof match[2] === "string" ? match[2].trim() : "";
      if (inlineText && mode !== "once") {
        return null;
      }
      return {
        name: "debug",
        mode,
        ...(inlineText ? { inlineText } : {})
      };
    },
    access: requireOwner,
    async execute(ctx: DirectCommandExecutionContext, command: ParsedDirectCommand) {
      const debugCommand = command as Extract<ParsedDirectCommand, { name: "debug" }>;
      switch (debugCommand.mode ?? "status") {
        case "on": {
          const state = ctx.input.sessionManager.setDebugEnabled(ctx.session.id, true);
          appendDebugMarker(ctx, {
            kind: "debug_enabled",
            note: "persistent_debug_enabled"
          });
          await ctx.send(`当前会话调试模式已开启。状态：常驻=${state.enabled ? "开" : "关"}，单次=${state.oncePending ? "待触发" : "无"}`);
          return;
        }
        case "off": {
          ctx.input.sessionManager.setDebugEnabled(ctx.session.id, false);
          appendDebugMarker(ctx, {
            kind: "debug_disabled",
            note: "persistent_debug_disabled"
          });
          await ctx.send("当前会话调试模式已关闭，后续回复将默认隐藏内部机制。");
          return;
        }
        case "once": {
          const state = ctx.input.sessionManager.armDebugOnce(ctx.session.id);
          appendDebugMarker(ctx, {
            kind: "debug_once_armed",
            note: debugCommand.inlineText ? "inline_debug_once_armed" : "debug_once_armed"
          });
          if (debugCommand.inlineText) {
            triggerInlineDebugOnce(ctx, debugCommand.inlineText);
            return;
          }
          await ctx.send(`当前会话已登记一次性调试。状态：常驻=${state.enabled ? "开" : "关"}，单次=${state.oncePending ? "待触发" : "无"}`);
          return;
        }
        case "status":
        default: {
          const state = ctx.input.sessionManager.getDebugControlState(ctx.session.id);
          await ctx.send(`当前会话调试状态：常驻=${state.enabled ? "开" : "关"}，单次=${state.oncePending ? "待触发" : "无"}`);
        }
      }
    }
  },
  {
    name: "reset",
    scope: "scenario_host",
    help: ".reset 重置场景状态并清空会话历史（仅 scenario_host 模式）",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: false
    },
    parse(text: string): ParsedDirectCommand | null {
      return /^[。.]\s*reset\s*$/i.test(text)
        ? { name: "reset" }
        : null;
    },
    async execute(ctx: DirectCommandExecutionContext) {
      if (!ctx.input.scenarioHostStateStore) {
        await ctx.send("当前实例未启用场景状态存储。");
        return;
      }
      const defaults = {
        playerUserId: ctx.session.participantRef.id,
        playerDisplayName: resolveSessionParticipantLabel({
          sessionId: ctx.session.id,
          participantRef: ctx.session.participantRef,
          title: ctx.session.title,
          type: ctx.session.type
        })
      };
      ctx.input.sessionManager.cancelGeneration(ctx.session.id);
      ctx.input.sessionManager.clearSession(ctx.session.id);
      await ctx.input.scenarioHostStateStore.write(ctx.session.id, createInitialScenarioHostSessionState(defaults));
      ctx.input.persistSession(ctx.session.id, "scenario_reset_by_command");
      ctx.input.logger.info({ sessionId: ctx.session.id }, "scenario_reset_by_command");
      await ctx.send("场景已重置，会话上下文已清空。");
    }
  },
  {
    name: "confirm",
    help: ".confirm 确认当前模式初始化完成",
    dispatch: {
      requireTextOnly: true
    },
    routing: {
      allowInPrivate: true,
      allowInOwnerMentionedGroup: false
    },
    parse(text: string): ParsedDirectCommand | null {
      return /^[。.]\s*confirm\s*$/i.test(text)
        ? { name: "confirm" }
        : null;
    },
    access(ctx: DirectCommandExecutionContext): string | null {
      const modeDef = requireSessionModeDefinition(ctx.session.modeId);
      if (!modeDef.setupPhase) {
        return "当前模式不需要初始化确认。";
      }
      return null;
    },
    async execute(ctx: DirectCommandExecutionContext) {
      const modeDef = requireSessionModeDefinition(ctx.session.modeId);
      if (!modeDef.setupPhase) {
        await ctx.send("当前模式不需要初始化确认。");
        return;
      }
      // For scenario_host: mark initialized in persistent state so it survives restarts
      if (ctx.session.modeId === "scenario_host" && ctx.input.scenarioHostStateStore) {
        const nextState = await ctx.input.scenarioHostStateStore.update(
          ctx.session.id,
          (current) => ({ ...current, initialized: true }),
          {
            playerUserId: ctx.session.participantRef.id,
            playerDisplayName: resolveSessionParticipantLabel({
              sessionId: ctx.session.id,
              participantRef: ctx.session.participantRef,
              title: ctx.session.title,
              type: ctx.session.type
            })
          }
        );
        await maybeCaptionScenarioSetupTitle(ctx, nextState);
      }
      // Mark confirmed in session (in-memory)
      ctx.input.sessionManager.markSetupConfirmed(ctx.session.id);
      // Handle onComplete policy immediately
      if (modeDef.setupPhase.onComplete === "clear_session") {
        ctx.input.sessionManager.cancelGeneration(ctx.session.id);
        ctx.input.sessionManager.clearSession(ctx.session.id);
      }
      ctx.input.persistSession(ctx.session.id, "setup_confirmed_by_command");
      ctx.input.logger.info({ sessionId: ctx.session.id, modeId: ctx.session.modeId }, "setup_confirmed_by_command");
      await ctx.send("初始化已确认，已进入正常模式。");
    }
  }
];

const directCommandDescriptorMap = new Map<DirectCommandName, DirectCommandDescriptor>();
for (const descriptor of directCommandDescriptors) {
  directCommandDescriptorMap.set(descriptor.name, descriptor);
}

export function parseDirectCommand(text: string): ParsedDirectCommand | null {
  const trimmed = text.trim();
  for (const descriptor of directCommandDescriptors) {
    const parsed = descriptor.parse(trimmed);
    if (parsed) {
      return parsed as ParsedDirectCommand;
    }
  }
  return null;
}

export function hasDirectCommandPrefix(text: string): boolean {
  return /^[。.]/.test(text.trim());
}

function canAttemptDirectCommand(context: DirectCommandRoutingContext): boolean {
  if (context.phase === "owner_bootstrap") {
    return context.setupState === "needs_owner" && context.chatType === "private";
  }
  if (context.chatType === "private") {
    return true;
  }
  return context.relationship === "owner" && context.isAtMentioned === true;
}

export function canExecuteDirectCommand(command: ParsedDirectCommand, context: DirectCommandRoutingContext): boolean {
  const descriptor = directCommandDescriptorMap.get(command.name);
  if (!descriptor) {
    return false;
  }

  if (context.phase === "owner_bootstrap") {
    return context.setupState === "needs_owner"
      && context.chatType === "private"
      && descriptor.routing?.allowBeforeOwnerBound === true;
  }

  // Scope check: if a command has a non-universal scope, only allow in the matching mode
  if (descriptor.scope && descriptor.scope !== "universal") {
    if (context.sessionModeId !== descriptor.scope) {
      return false;
    }
  }

  if (context.chatType === "private") {
    return descriptor.routing?.allowInPrivate !== false;
  }

  return descriptor.routing?.allowInOwnerMentionedGroup === true
    && context.relationship === "owner"
    && context.isAtMentioned === true;
}

export function resolveDispatchableDirectCommand(context: DirectCommandDispatchContext): ResolvedDirectCommand | null {
  const trimmedText = context.text.trim();
  if (!trimmedText) {
    return null;
  }

  for (const descriptor of directCommandDescriptors) {
    if (
      descriptor.dispatch?.requireTextOnly !== false
      && (context.hasImages || context.hasForwards || context.hasAudio)
    ) {
      continue;
    }
    const parsed = descriptor.parse(trimmedText);
    if (!parsed) {
      continue;
    }
    if (canExecuteDirectCommand(parsed, context)) {
      return parsed;
    }
  }

  if (hasDirectCommandPrefix(trimmedText) && canAttemptDirectCommand(context)) {
    return {
      name: "unknown",
      rawText: trimmedText
    };
  }

  return null;
}

export function createDirectCommandHandler(
  input: DirectCommandHandlerInput
): (params: {
  command: ResolvedDirectCommand;
  sessionId: string;
  incomingMessage: DirectCommandIncomingMessage;
}) => Promise<void> {
  return async (params) => {
    const session = input.sessionManager.ensureSession({
      id: params.sessionId,
      type: params.incomingMessage.chatType
    });
    const ownerAssignmentAvailable = input.isOwnerAssignmentAvailable
      ? await input.isOwnerAssignmentAvailable()
      : false;
    const context: DirectCommandExecutionContext = {
      input,
      session,
      incomingMessage: params.incomingMessage,
      ownerAssignmentAvailable,
      commandName: params.command.name,
      send: async (text: string) => input.sendImmediateText({
        sessionId: session.id,
        userId: params.incomingMessage.userId,
        ...(params.incomingMessage.groupId ? { groupId: params.incomingMessage.groupId } : {}),
        text,
        recordInHistory: false,
        transcriptItem: {
          kind: "direct_command",
          llmVisible: false,
          direction: "output",
          role: "assistant",
          commandName: params.command.name,
          content: text,
          timestampMs: Date.now()
        },
        recordForRetract: false,
        autoRetractAfterMs: 60_000
      })
    };

    if (params.command.name === "unknown") {
      await context.send(`未知指令：${params.command.rawText}\n发送 .help 查看可用指令。`);
      return;
    }

    const descriptor = directCommandDescriptorMap.get(params.command.name);
    if (!descriptor) {
      return;
    }

    const denied = descriptor.access?.(context) ?? null;
    if (denied) {
      await context.send(denied);
      return;
    }

    await descriptor.execute(context as never, params.command as never);
  };
}

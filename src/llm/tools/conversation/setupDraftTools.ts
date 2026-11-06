import { DeliveryCoordinator } from "#services/messaging/deliveryCoordinator.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { stateChangePolicy } from "../core/resultObservationPresets.ts";
import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { editableRpProfileFieldNames, rpProfileFieldLabels } from "#modes/rpAssistant/profileSchema.ts";
import { formatScenarioHostRuntimeDraftLines } from "#modes/scenarioHost/draftFormatting.ts";
import { editableScenarioProfileFieldNames, scenarioProfileFieldLabels } from "#modes/scenarioHost/profileSchema.ts";
import { editablePersonaFieldNames, personaFieldLabels } from "#persona/personaSchema.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import { captureSessionMutationGuard } from "../core/sessionMutationGuard.ts";
import { characterRepository } from "../../../character/repository.ts";
import { formatCharacterDraft } from "../../../character/draftFormatting.ts";

export const setupDraftToolDescriptors: ToolDescriptor[] = [
  {
    modelPolicy: { kind: "bounded_content" },
    definition: {
      type: "function",
      function: {
        name: "send_setup_draft",
        description: "发送当前 setup 或 config 临时草稿的完整核对文本，供用户确认；只在 setup 或 config 草稿阶段使用。",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "可选补充说明。工具会自动读取当前临时草稿并发送完整草稿，不要只传本轮新增内容。"
            }
          },
          additionalProperties: false
        }
      }
    },
    accessLevel: "owner",
    resultObservation: stateChangePolicy()
  }
];

export const setupDraftToolHandlers: Record<string, ToolHandler> = {
  async send_setup_draft(_toolCall, args, context) {
    const sessionId = context.lastMessage.sessionId;
    const operationMode = context.sessionManager.getOperationMode(sessionId);
    if (isScenarioHostOperationMode(operationMode) && !context.scenarioHostStateStore) {
      return JSON.stringify({ error: "scenario_host_state_store_unavailable" });
    }
    const session = context.sessionManager.getSession(sessionId);
    const isSessionCurrent = captureSessionMutationGuard(context.sessionManager, sessionId);
    let isCurrent = isSessionCurrent;
    let draftContent: string;
    const extraContent = getStringArg(args, "content").trim();
    if (operationMode.kind === "character_config") {
      if (context.relationship !== "owner") return JSON.stringify({ error: "角色配置仅 owner 可访问" });
      const store = characterRepository(context.config.dataDir);
      const draft = store.draft(sessionId);
      if (!draft || draft.stage !== operationMode.stage
        || context.expectedCharacterDraftId !== undefined && draft.id !== context.expectedCharacterDraftId
        || !store.sections(sessionId, session.modeId).some(section => section.writable)) {
        return JSON.stringify({ error: "角色草稿已取消或配置阶段已变化，请重新读取当前草稿。" });
      }
      const valueSnapshot = JSON.stringify(draft.value);
      const modeId = session.modeId;
      isCurrent = () => {
        if (!isSessionCurrent()) return false;
        const currentMode = context.sessionManager.getOperationMode(sessionId);
        const current = store.draft(sessionId);
        return currentMode.kind === "character_config" && currentMode.stage === draft.stage
          && context.sessionManager.getSession(sessionId).modeId === modeId
          && current?.id === draft.id && JSON.stringify(current.value) === valueSnapshot;
      };
      draftContent = formatCharacterDraft(draft);
    } else {
      draftContent = await buildDraftContent(context, session, operationMode);
    }
    const content = draftContent && extraContent ? `${draftContent}\n\n补充说明：\n${extraContent}` : draftContent || extraContent;
    if (!isCurrent()) return JSON.stringify({ error: "会话已清空或变更，草稿未发送。" });
    if (!content) {
      return JSON.stringify({ error: "content or active setup draft is required" });
    }
    const lease = context.replyDelivery === "web" ? undefined : context.beginExternalDelivery?.();
    void context.messageQueue.enqueueText({
      sessionId,
      text: content,
      pacing: session.pacingPreferences.outbound,
      ...(context.outboundSignal ? { abortSignals: [context.outboundSignal] } : {}),
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
      send: async () => {
        await lease?.ready;
        if (!isCurrent()) return;
        context.outboundSignal?.throwIfAborted();
        context.abortSignal?.throwIfAborted();
        if (context.replyDelivery === "web") {
          await context.committedTextSink?.commitText(content);
          if (!isSessionCurrent()) return;
          context.sessionManager.appendAssistantHistory(sessionId, {
            chatType: session.type,
            userId: context.lastMessage.userId,
            senderName: context.lastMessage.senderName,
            text: content
          });
          return;
        }

        const parsedSession = parseChatSessionIdentity(sessionId);
        if (!parsedSession) {
          throw new Error(`unsupported session target: ${sessionId}`);
        }
        const deliveryRef = await (context.messaging ?? new DeliveryCoordinator(context.oneBotClient)).sendText({
          sessionId, replyContext: context.replyContext, signal: context.outboundSignal
        }, content);
        if (!isSessionCurrent()) return;
        if (deliveryRef?.platform === "onebot") {
          context.sessionManager.recordSentMessage(sessionId, { messageId: deliveryRef.messageId, text: content, sentAt: Date.now() });
        }
        context.sessionManager.appendAssistantHistory(sessionId, {
          chatType: session.type,
          userId: context.lastMessage.userId,
          senderName: context.lastMessage.senderName,
          text: content,
          ...(deliveryRef ? { deliveryRef } : {})
        });
      }
    }).finally(() => lease?.settle()).catch(() => undefined);
    return JSON.stringify({ ok: true, queued: true });
  }
};

async function buildDraftContent(
  context: Parameters<ToolHandler>[2],
  session: ReturnType<Parameters<ToolHandler>[2]["sessionManager"]["getSession"]>,
  operationMode: SessionOperationMode | null
): Promise<string> {
  const scenarioState = isScenarioHostOperationMode(operationMode)
    ? await context.scenarioHostStateStore.ensureForSession(session)
    : null;
  return operationMode ? formatOperationModeDraft(operationMode, scenarioState ? formatScenarioHostRuntimeDraftLines(scenarioState) : []) : "";
}

function isScenarioHostOperationMode(operationMode: SessionOperationMode | null): boolean {
  return Boolean(operationMode && operationMode.kind !== "normal" && "modeId" in operationMode && operationMode.modeId === "scenario_host");
}

function formatOperationModeDraft(operationMode: SessionOperationMode, scenarioRuntimeLines: string[] = []): string {
  switch (operationMode.kind) {
    case "persona_setup":
    case "persona_config":
      return formatSetupDraft(
        `Persona ${operationMode.kind === "persona_setup" ? "初始化" : "配置"}草稿`,
        editablePersonaFieldNames.map((field) => ({
          label: personaFieldLabels[field],
          value: operationMode.draft[field]
        }))
      );
    case "mode_setup":
    case "mode_config":
      if (operationMode.modeId === "rp_assistant") {
        return formatSetupDraft(
          `RP 资料${operationMode.kind === "mode_setup" ? "初始化" : "配置"}草稿`,
          editableRpProfileFieldNames.map((field) => ({
            label: rpProfileFieldLabels[field],
            value: operationMode.draft[field]
          }))
        );
      }
      return formatSetupDraft(
        `Scenario 资料${operationMode.kind === "mode_setup" ? "初始化" : "配置"}草稿`,
        editableScenarioProfileFieldNames.map((field) => ({
          label: scenarioProfileFieldLabels[field],
          value: operationMode.draft[field]
        })),
        scenarioRuntimeLines
      );
    case "character_config":
    case "skill_config":
    case "normal":
      return "";
  }
}

function formatSetupDraft(title: string, fields: Array<{ label: string; value: string }>, extraLines: string[] = []): string {
  return [
    title,
    ...fields.map((field) => `${field.label}：${formatDraftFieldValue(field.value)}`),
    ...(extraLines.length > 0 ? ["", ...extraLines] : []),
    "",
    "确认无误后输入 .confirm 保存；需要调整请继续说明。"
  ].join("\n");
}

function formatDraftFieldValue(value: string): string {
  const trimmed = value.trim();
  return trimmed || "（未填写）";
}

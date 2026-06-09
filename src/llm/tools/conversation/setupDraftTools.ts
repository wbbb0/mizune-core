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

export const setupDraftToolDescriptors: ToolDescriptor[] = [
  {
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
    const content = await buildDraftContent(context, session, operationMode, getStringArg(args, "content").trim());
    if (!content) {
      return JSON.stringify({ error: "content or active setup draft is required" });
    }
    context.messageQueue.enqueueTextDetached({
      sessionId,
      text: content,
      pacing: context.replyDelivery === "web" ? "immediate" : "humanized",
      send: async () => {
        if (context.replyDelivery === "web") {
          await context.committedTextSink?.commitText(content);
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
        const sendTarget = parsedSession.kind === "private"
          ? { userId: parsedSession.userId, text: content }
          : { groupId: parsedSession.groupId, text: content };
        const payload = await context.oneBotClient.sendText(sendTarget);
        const messageId = normalizeOneBotMessageId(payload.data?.message_id);
        if (messageId != null) {
          context.sessionManager.recordSentMessage(sessionId, {
            messageId,
            text: content,
            sentAt: Date.now()
          });
        }
        context.sessionManager.appendAssistantHistory(sessionId, {
          chatType: session.type,
          userId: context.lastMessage.userId,
          senderName: context.lastMessage.senderName,
          text: content,
          ...(messageId != null ? {
            deliveryRef: {
              platform: "onebot" as const,
              messageId
            }
          } : {})
        });
      }
    });
    return JSON.stringify({ ok: true, queued: true, sent: true });
  }
};

async function buildDraftContent(
  context: Parameters<ToolHandler>[2],
  session: ReturnType<Parameters<ToolHandler>[2]["sessionManager"]["getSession"]>,
  operationMode: SessionOperationMode | null,
  extraContent: string
): Promise<string> {
  const scenarioState = isScenarioHostOperationMode(operationMode)
    ? await context.scenarioHostStateStore.ensureForSession(session)
    : null;
  const draft = operationMode ? formatOperationModeDraft(operationMode, scenarioState ? formatScenarioHostRuntimeDraftLines(scenarioState) : []) : "";
  if (!draft) {
    return extraContent;
  }
  if (!extraContent) {
    return draft;
  }
  return `${draft}\n\n补充说明：\n${extraContent}`;
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

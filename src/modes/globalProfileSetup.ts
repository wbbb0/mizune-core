import type {
  SessionModeGlobalProfileAccess,
  SessionModeSetupContext,
  SessionModeSetupOperation,
  SessionModeSetupOperationKind,
  SessionModeSetupPhase,
  SessionModeSetupToolsetOverride
} from "./types.ts";

function createPersonaSetupToolsetOverrides(): SessionModeSetupToolsetOverride[] {
  return [
    {
      toolsetId: "memory_profile",
      title: "长期资料与规则",
      description: "初始化阶段仅允许写入 persona 相关资料。",
      toolNames: ["get_persona", "patch_persona", "clear_persona_field"],
      promptGuidance: ["初始化阶段只补全 persona；不要改用户资料、关系或其他记忆。"],
      plannerSignals: ["初始化 persona 补全"]
    },
    {
      toolsetId: "setup_draft",
      title: "设定草稿",
      description: "以独立消息发送当前设定草稿供用户审阅。",
      toolNames: ["send_setup_draft"],
      promptGuidance: ["设定字段收集到一定程度后，用此工具发送格式化草稿；不要在回复正文中列出草稿内容。"],
      plannerSignals: ["发送设定草稿"]
    }
  ];
}

function createModeProfileSetupToolsetOverrides(target: NonNullable<SessionModeGlobalProfileAccess["modeProfile"]>): SessionModeSetupToolsetOverride[] {
  if (target === "rp") {
    return [
      {
        toolsetId: "rp_profile_draft",
        title: "RP 资料草稿",
        description: "初始化阶段仅允许写入 RP 全局资料草稿。",
        toolNames: ["get_rp_profile", "patch_rp_profile", "clear_rp_profile_field"],
        promptGuidance: ["初始化阶段只补全 RP 全局资料；不要改 persona、用户资料或其他记忆。"],
        plannerSignals: ["初始化 RP 全局资料"]
      },
      {
        toolsetId: "setup_draft",
        title: "设定草稿",
        description: "以独立消息发送当前设定草稿供用户审阅。",
        toolNames: ["send_setup_draft"],
        promptGuidance: ["设定字段收集到一定程度后，用此工具发送格式化草稿；不要在回复正文中列出草稿内容。"],
        plannerSignals: ["发送设定草稿"]
      }
    ];
  }

  return [
    {
      toolsetId: "scenario_profile_draft",
      title: "Scenario 资料草稿",
      description: "初始化阶段用于填写 Scenario 全局资料草稿。",
      toolNames: ["get_scenario_profile", "patch_scenario_profile", "clear_scenario_profile_field"],
      promptGuidance: ["初始化阶段只补全 Scenario 全局资料；不要改 persona、用户资料或其他记忆。"],
      plannerSignals: ["写入 Scenario 全局资料"]
    },
    {
      toolsetId: "setup_draft",
      title: "设定草稿",
      description: "以独立消息发送当前场景草稿供用户审阅。",
      toolNames: ["send_setup_draft"],
      promptGuidance: ["收集到一定量信息后，用此工具发送格式化草稿；不要在回复正文中列出草稿内容。"],
      plannerSignals: ["发送场景草稿"]
    }
  ];
}

function resolveOwnerPrivateSetupOperationKind(
  access: SessionModeGlobalProfileAccess,
  ctx: SessionModeSetupContext
): SessionModeSetupOperationKind | null {
  if (ctx.operationMode.kind === "persona_setup" || ctx.operationMode.kind === "mode_setup") {
    return ctx.operationMode.kind;
  }
  if (ctx.chatType !== "private" || ctx.relationship !== "owner") {
    return null;
  }
  if (access.persona && !ctx.personaReady) {
    return "persona_setup";
  }
  if (access.modeProfile && !ctx.modeProfileReady) {
    return "mode_setup";
  }
  return null;
}

export function createOwnerPrivateGlobalProfileSetupPhase(
  access: SessionModeGlobalProfileAccess
): SessionModeSetupPhase {
  const operations: SessionModeSetupOperation[] = [];
  if (access.persona) {
    operations.push({
      kind: "persona_setup",
      setupToolsetOverrides: createPersonaSetupToolsetOverrides(),
      promptMode: "persona_setup",
      completionSignal: "user_command",
      onComplete: "clear_session"
    });
  }
  if (access.modeProfile) {
    operations.push({
      kind: "mode_setup",
      setupToolsetOverrides: createModeProfileSetupToolsetOverrides(access.modeProfile),
      promptMode: "chat_with_setup_injection",
      completionSignal: "user_command",
      onComplete: "clear_session"
    });
  }

  return {
    resolveOperationModeKind(ctx) {
      return resolveOwnerPrivateSetupOperationKind(access, ctx);
    },
    operations
  };
}

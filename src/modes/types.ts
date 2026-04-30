import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";

export type SessionModeChatType = "private" | "group";
export type SessionModeOperationKind = Exclude<SessionOperationMode["kind"], "normal">;
export type SessionModeSetupOperationKind = Extract<SessionModeOperationKind, "persona_setup" | "mode_setup">;
export type SessionModeProfileTarget = "rp" | "scenario";

export interface SessionModeGlobalProfileAccess {
  persona: boolean;
  modeProfile: SessionModeProfileTarget | null;
}

export interface SessionModeSetupContext {
  personaReady: boolean;
  modeProfileReady: boolean;
  operationMode: SessionOperationMode;
  chatType: "private" | "group";
  relationship: string;
}

export interface SessionModeSetupToolsetOverride {
  toolsetId: string;
  title?: string;
  description?: string;
  toolNames: string[];
  plannerSignals?: string[];
}

export type SetupCompletionSignal = "global_setup_ready" | "session_state_initialized" | "user_command";

export interface SessionModeSetupOperation {
  kind: SessionModeSetupOperationKind;
  setupToolsetOverrides?: SessionModeSetupToolsetOverride[];
  promptMode: "persona_setup" | "chat_with_setup_injection";
  completionSignal: SetupCompletionSignal;
  onComplete: "clear_session" | "none";
}

export interface SessionModeSetupPhase {
  resolveOperationModeKind(ctx: SessionModeSetupContext): SessionModeOperationKind | null;
  operations: SessionModeSetupOperation[];
}

export function isSessionModeSetupOperationKind(
  kind: SessionModeOperationKind | null
): kind is SessionModeSetupOperationKind {
  return kind === "persona_setup" || kind === "mode_setup";
}

export function resolveSessionModeSetupOperation(
  setupPhase: SessionModeSetupPhase | undefined,
  kind: SessionModeOperationKind | null
): SessionModeSetupOperation | null {
  if (!setupPhase || !isSessionModeSetupOperationKind(kind)) {
    return null;
  }
  return setupPhase.operations.find((item) => item.kind === kind) ?? null;
}

export interface SessionModeDefinition {
  id: string;
  title: string;
  description: string;
  allowedChatTypes: SessionModeChatType[];
  defaultToolsetIds: string[];
  globalProfileAccess: SessionModeGlobalProfileAccess;
  setupPhase?: SessionModeSetupPhase;
}

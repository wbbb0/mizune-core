export type SessionModeChatType = "private" | "group";

export interface SessionModeSetupContext {
  globalSetupReady: boolean;
  sessionStateInitialized: boolean;
  chatType: "private" | "group";
  relationship: string;
}

export interface SessionModeSetupToolsetOverride {
  toolsetId: string;
  title?: string;
  description?: string;
  toolNames: string[];
  promptGuidance?: string[];
  plannerSignals?: string[];
}

export type SetupCompletionSignal = "global_setup_ready" | "session_state_initialized";

export interface SessionModeSetupPhase {
  needsSetup(ctx: SessionModeSetupContext): boolean;
  setupToolsetOverrides?: SessionModeSetupToolsetOverride[];
  promptMode: "persona_setup" | "chat_with_setup_injection";
  completionSignal: SetupCompletionSignal;
  onComplete: "clear_session" | "none";
}

export interface SessionModeDefinition {
  id: string;
  title: string;
  description: string;
  allowedChatTypes: SessionModeChatType[];
  defaultToolsetIds: string[];
  setupPhase?: SessionModeSetupPhase;
}

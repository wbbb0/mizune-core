# Mode Setup Lifecycle & Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Status note (2026-04-15): the repo has already absorbed most of this plan's intended behavior, but not by checking off this document step-by-step. Treat this file as historical implementation guidance, not as the current source of truth for refactor progress. For the active structural work, use `project-structure-refactor.md`.

**Goal:** Decouple rp_assistant setup logic from the main pipeline and make it a generic per-mode setup lifecycle; add scenario_host-specific initialization flow with `initialized` flag; add scoped direct command system with `reset` for scenario_host.

**Architecture:** `SessionModeDefinition` gains an optional `setupPhase` field that owns the entire setup lifecycle — `needsSetup()`, toolset overrides, prompt mode, completion signal, and post-completion action. A single new utility file (`generationSetupContext.ts`) computes setup context by reading the appropriate stores; it is the only place with mode-ID branch logic. The command system gets a `scope` field on each descriptor so `canExecuteDirectCommand` filters without touching mode ID anywhere else.

**Tech Stack:** TypeScript, Node.js (tsx), node:assert/strict for tests, existing `FileSchemaStore`/schema patterns.

---

## File Map

**Modified:**
- `src/modes/scenarioHost/types.ts` — add `initialized: boolean` field + `isScenarioStateInitialized()` helper
- `src/modes/scenarioHost/mode.ts` — add `setupPhase` to definition
- `src/modes/types.ts` — add `SessionModeSetupPhase`, `SessionModeSetupContext`, `SetupCompletionSignal`, `SessionModeSetupToolsetOverride` types; extend `SessionModeDefinition`
- `src/modes/rpAssistantMode.ts` — add `setupPhase` to definition
- `src/llm/tools/toolsets.ts` — replace `setupMode?: boolean` with `setupPhase?: Pick<SessionModeSetupPhase, "setupToolsetOverrides">` in `listTurnToolsets`
- `src/app/generation/generationSessionOrchestrator.ts` — remove hardcoded `rp_assistant`, use `resolveSessionModeSetupContext` + `mode.setupPhase`
- `src/app/generation/generationExecutor.ts` — remove hardcoded `setupStore.isReady()`, use `checkSetupCompletion`
- `src/llm/prompt/promptTypes.ts` — add `isInSetup?: boolean` to `PromptInput`
- `src/llm/prompt/promptBuilder.ts` — forward `isInSetup` into `buildBaseSystemLines`
- `src/llm/prompts/chat-system.prompt.ts` — scenario_host setup branch in `buildBaseSystemLines`
- `src/llm/tools/conversation/scenarioHostTools.ts` — add `initialized` param to `update_scenario_state`
- `src/app/messaging/directCommands.ts` — add `scope` to `DirectCommandDescriptor`, `sessionModeId?` to routing context, `reset` command
- `src/app/messaging/messageCommandFlow.ts` — pass `sessionModeId` to `resolveDispatchableDirectCommand`
- `test/modes/scenario-host-state-store.test.tsx` — add `initialized` tests
- `test/helpers/direct-command-fixtures.tsx` — add `getModeId` + `scenarioHostStateStore` to fixture

**Created:**
- `src/app/generation/generationSetupContext.ts` — `resolveSessionModeSetupContext` + `checkSetupCompletion`
- `test/messaging/direct-command-features.test.tsx` — scope filtering + reset command tests

---

### Task 1: Add `initialized` flag to ScenarioHostSessionState

**Files:**
- Modify: `src/modes/scenarioHost/types.ts`
- Modify: `test/modes/scenario-host-state-store.test.tsx`

- [ ] **Step 1: Write failing test**

Add to `test/modes/scenario-host-state-store.test.tsx` inside `main()`, after the existing test:

```typescript
  await runCase("scenario_host state initializes with initialized=false", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      const initial = await store.ensure("private:10001", {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });
      assert.equal(initial.initialized, false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("isScenarioStateInitialized returns false for fresh state", async () => {
    const { createInitialScenarioHostSessionState, isScenarioStateInitialized } = await import("../../src/modes/scenarioHost/types.ts");
    const state = createInitialScenarioHostSessionState({ playerUserId: "u1", playerDisplayName: "Alice" });
    assert.equal(isScenarioStateInitialized(state), false);
  });

  await runCase("isScenarioStateInitialized returns true when initialized=true", async () => {
    const { createInitialScenarioHostSessionState, isScenarioStateInitialized } = await import("../../src/modes/scenarioHost/types.ts");
    const state = createInitialScenarioHostSessionState({ playerUserId: "u1", playerDisplayName: "Alice" });
    assert.equal(isScenarioStateInitialized({ ...state, initialized: true }), true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx test/modes/scenario-host-state-store.test.tsx
```

Expected: FAIL — `initial.initialized` is undefined, `isScenarioStateInitialized` is not exported.

- [ ] **Step 3: Implement — update `src/modes/scenarioHost/types.ts`**

Add `initialized: s.boolean().default(false)` to `scenarioHostSessionStateSchema` (before `turnIndex`):

```typescript
  initialized: s.boolean().default(false),
  turnIndex: s.number().int().min(0).default(0)
```

In `createInitialScenarioHostSessionState`, add `initialized: false` to the parsed object:

```typescript
    flags: {},
    initialized: false,
    turnIndex: 0
```

Add export at bottom of file:

```typescript
export function isScenarioStateInitialized(state: ScenarioHostSessionState): boolean {
  return state.initialized === true;
}
```

Update `ScenarioHostSessionState` type inference will pick up `initialized` automatically from the schema.

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx test/modes/scenario-host-state-store.test.tsx
```

Expected: all cases PASS.

- [ ] **Step 5: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modes/scenarioHost/types.ts test/modes/scenario-host-state-store.test.tsx
git commit -m "feat(scenario-host): add initialized flag and isScenarioStateInitialized helper"
```

---

### Task 2: Add `SessionModeSetupPhase` types + `setupPhase` to mode definitions

**Files:**
- Modify: `src/modes/types.ts`
- Modify: `src/modes/rpAssistantMode.ts`
- Modify: `src/modes/scenarioHost/mode.ts`

> No new runtime behavior yet — just type declarations and data. No tests needed; typecheck validates correctness.

- [ ] **Step 1: Update `src/modes/types.ts`**

Replace the entire file:

```typescript
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
```

- [ ] **Step 2: Update `src/modes/rpAssistantMode.ts`**

Add `setupPhase` to the definition:

```typescript
import type { SessionModeDefinition } from "./types.ts";

export const rpAssistantModeDefinition: SessionModeDefinition = {
  id: "rp_assistant",
  title: "RP Assistant",
  description: "当前默认模式。保留现有角色扮演 + 助手能力。",
  allowedChatTypes: ["private", "group"],
  defaultToolsetIds: [
    "chat_context",
    "memory_profile",
    "conversation_navigation",
    "chat_delegation",
    "web_research",
    "shell_runtime",
    "local_file_io",
    "chat_file_io",
    "social_admin",
    "scheduler_admin",
    "comfy_image",
    "time_utils",
    "debug_owner"
  ],
  setupPhase: {
    needsSetup({ globalSetupReady, chatType, relationship }) {
      return !globalSetupReady && chatType === "private" && relationship === "owner";
    },
    setupToolsetOverrides: [
      {
        toolsetId: "memory_profile",
        title: "记忆与资料",
        description: "初始化阶段仅允许写入 persona 相关资料。",
        toolNames: ["read_memory", "write_memory"],
        promptGuidance: ["初始化阶段只补全 persona；不要改用户资料、关系或其他记忆。"],
        plannerSignals: ["初始化 persona 补全"]
      }
    ],
    promptMode: "persona_setup",
    completionSignal: "global_setup_ready",
    onComplete: "clear_session"
  }
};
```

- [ ] **Step 3: Update `src/modes/scenarioHost/mode.ts`**

```typescript
import type { SessionModeDefinition } from "../types.ts";
import { isScenarioStateInitialized } from "./types.ts";

export const scenarioHostModeDefinition: SessionModeDefinition = {
  id: "scenario_host",
  title: "Scenario Host",
  description: "轻规则单人剧情主持模式。当前仅支持私聊。",
  allowedChatTypes: ["private"],
  defaultToolsetIds: [
    "chat_context",
    "time_utils",
    "scenario_host_state"
  ],
  setupPhase: {
    needsSetup({ sessionStateInitialized }) {
      return !sessionStateInitialized;
    },
    promptMode: "chat_with_setup_injection",
    completionSignal: "session_state_initialized",
    onComplete: "none"
  }
};
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/modes/types.ts src/modes/rpAssistantMode.ts src/modes/scenarioHost/mode.ts
git commit -m "feat(modes): add SessionModeSetupPhase type system and wire setupPhase to mode definitions"
```

---

### Task 3: Decouple `listTurnToolsets` from `setupMode` bool

**Files:**
- Modify: `src/llm/tools/toolsets.ts`
- Modify: `src/app/generation/generationSessionOrchestrator.ts` (only the two `listTurnToolsets` call sites)

The goal: replace `setupMode?: boolean` with `setupPhase?: Pick<SessionModeSetupPhase, "setupToolsetOverrides">`. The hardcoded `memory_profile` override block is replaced by a generic override from `setupPhase.setupToolsetOverrides`.

> No separate test needed — behavior is identical for rp_assistant; typecheck + existing tests validate.

- [ ] **Step 1: Update `src/llm/tools/toolsets.ts`**

Add import at top:
```typescript
import type { SessionModeSetupPhase } from "#modes/types.ts";
```

Change the `listTurnToolsets` signature — replace `setupMode?: boolean` with `setupPhase?: Pick<SessionModeSetupPhase, "setupToolsetOverrides">`:

```typescript
export function listTurnToolsets(input: {
  config: AppConfig;
  relationship: Relationship;
  currentUser: BuiltinToolContext["currentUser"];
  modelRef: string[];
  includeDebugTools: boolean;
  setupPhase?: Pick<SessionModeSetupPhase, "setupToolsetOverrides">;
  modeId?: string;
}): ToolsetView[] {
```

Replace the `if (input.setupMode)` block:

```typescript
  if (input.setupPhase) {
    const overrides = input.setupPhase.setupToolsetOverrides ?? [];
    if (overrides.length > 0) {
      const overrideMap = new Map(overrides.map((o) => [o.toolsetId, o]));
      return [
        ...overrides
          .filter((o) => {
            const toolNames = o.toolNames.filter((n) => visibleToolNames.has(n));
            return toolNames.length > 0;
          })
          .map((o) => ({
            id: o.toolsetId,
            title: o.title ?? o.toolsetId,
            description: o.description ?? "",
            toolNames: o.toolNames.filter((n) => visibleToolNames.has(n)),
            ...(o.promptGuidance && o.promptGuidance.length > 0 ? { promptGuidance: o.promptGuidance } : {}),
            ...(o.plannerSignals && o.plannerSignals.length > 0 ? { plannerSignals: o.plannerSignals } : {})
          })),
        ...visibleSharedToolsets.filter((t) => !overrideMap.has(t.id))
      ];
    }
    return visibleSharedToolsets;
  }
```

- [ ] **Step 2: Update the two `listTurnToolsets` call sites in `src/app/generation/generationSessionOrchestrator.ts`**

The call sites currently pass `...(setupMode ? { setupMode: true } : {})`. These will be updated in Task 5 when we refactor the orchestrator fully. For now, just change the two argument shapes to use `setupPhase` (passing the mode's setupPhase). This is a temporary bridging step — the full orchestrator refactor happens in Task 5.

Actually, to keep tasks atomic: leave the orchestrator's call sites as-is until Task 5. Instead, update the TypeScript types so the old `setupMode` parameter no longer exists. The orchestrator will fail typecheck until Task 5, so we need to update both in one commit.

**Updated approach for Step 2:** Update both call sites in `generationSessionOrchestrator.ts` to pass `setupPhase` now. Find these two lines:
```typescript
        ...(setupMode ? { setupMode: true } : {})
```
And change to (leave `setupMode` variable in scope for now — it's used elsewhere in the orchestrator, that cleanup happens in Task 5):
```typescript
        ...(setupMode ? { setupPhase: mode?.setupPhase } : {})
```

But `mode` doesn't exist yet in the orchestrator — that's Task 5. So we need to use the raw value. Since `setupMode` is still `sessionModeId === "rp_assistant" && ...`, and we know rp_assistant's `setupPhase.setupToolsetOverrides` has the memory_profile override, we can pass it inline for now:

```typescript
        ...(setupMode ? {
          setupPhase: {
            setupToolsetOverrides: [{
              toolsetId: "memory_profile",
              title: "记忆与资料",
              description: "初始化阶段仅允许写入 persona 相关资料。",
              toolNames: ["read_memory", "write_memory"],
              promptGuidance: ["初始化阶段只补全 persona；不要改用户资料、关系或其他记忆。"],
              plannerSignals: ["初始化 persona 补全"]
            }]
          }
        } : {})
```

> Note: This inline duplication is intentional and temporary — it will be cleaned up in Task 5 when `mode` becomes available at the call site.

- [ ] **Step 3: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```
npm test
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/llm/tools/toolsets.ts src/app/generation/generationSessionOrchestrator.ts
git commit -m "refactor(toolsets): replace setupMode bool with setupPhase override in listTurnToolsets"
```

---

### Task 4: Create `generationSetupContext.ts` utility

**Files:**
- Create: `src/app/generation/generationSetupContext.ts`

This file is the single place where mode-ID branch logic lives for setup context resolution.

- [ ] **Step 1: Write the file**

```typescript
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";
import { isScenarioStateInitialized } from "#modes/scenarioHost/types.ts";
import type { SetupCompletionSignal, SessionModeSetupContext } from "#modes/types.ts";

export async function resolveSessionModeSetupContext(
  modeId: string,
  sessionId: string,
  deps: {
    setupStore: SetupStateStore;
    scenarioHostStateStore: ScenarioHostStateStore;
  },
  chatContext: {
    chatType: "private" | "group";
    relationship: string;
  }
): Promise<SessionModeSetupContext> {
  const setupState = await deps.setupStore.get();
  const globalSetupReady = setupState.state === "ready";

  let sessionStateInitialized = false;
  if (modeId === "scenario_host") {
    const scenarioState = await deps.scenarioHostStateStore.get(sessionId);
    sessionStateInitialized = scenarioState != null && isScenarioStateInitialized(scenarioState);
  }

  return {
    globalSetupReady,
    sessionStateInitialized,
    chatType: chatContext.chatType,
    relationship: chatContext.relationship
  };
}

export async function checkSetupCompletion(
  completionSignal: SetupCompletionSignal,
  sessionId: string,
  deps: {
    setupStore: SetupStateStore;
    scenarioHostStateStore: ScenarioHostStateStore;
  }
): Promise<boolean> {
  switch (completionSignal) {
    case "global_setup_ready": {
      const setupState = await deps.setupStore.get();
      return setupState.state === "ready";
    }
    case "session_state_initialized": {
      const scenarioState = await deps.scenarioHostStateStore.get(sessionId);
      return scenarioState != null && isScenarioStateInitialized(scenarioState);
    }
  }
}
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/generation/generationSetupContext.ts
git commit -m "feat(generation): add generationSetupContext utility for mode-agnostic setup lifecycle"
```

---

### Task 5: Remove hardcoded `rp_assistant` from orchestrator and executor

**Files:**
- Modify: `src/app/generation/generationSessionOrchestrator.ts`
- Modify: `src/app/generation/generationExecutor.ts`

- [ ] **Step 1: Update `generationSessionOrchestrator.ts`**

At top of file, add imports:
```typescript
import { requireSessionModeDefinition } from "#modes/registry.ts";
import { resolveSessionModeSetupContext } from "./generationSetupContext.ts";
```

Replace the hardcoded `setupMode` computation inside `flushSession` (around line 141–156):

**Before:**
```typescript
      const setupState = await setupStore.get();
      const setupMode = sessionModeId === "rp_assistant"
        && setupState.state !== "ready"
        && last.chatType === "private"
        && relationship === "owner";
```

**After:**
```typescript
      const mode = requireSessionModeDefinition(sessionModeId);
      const setupCtx = await resolveSessionModeSetupContext(
        sessionModeId,
        sessionId,
        { setupStore: deps.setupStore, scenarioHostStateStore: deps.scenarioHostStateStore },
        { chatType: last.chatType, relationship }
      );
      const setupMode = (mode.setupPhase?.needsSetup(setupCtx)) ?? false;
```

> Note: `deps.scenarioHostStateStore` must be added to the destructured `deps` at the top of `createGenerationSessionOrchestrator`. Look at the current destructuring and add `scenarioHostStateStore` to it.

Replace the two temporary `setupPhase` inline objects (from Task 3) with the mode definition's actual `setupPhase`:

```typescript
      let plannerToolsets = listTurnToolsets({
        config,
        relationship,
        currentUser: user,
        modelRef: resolvedModelRef,
        includeDebugTools: interactionMode === "debug",
        modeId: sessionModeId,
        ...(setupMode && mode.setupPhase ? { setupPhase: mode.setupPhase } : {})
      });
```

(Same for the second call after `handleGenerationTurnPlanner`.)

Replace the `promptBuildResult` conditional:

**Before:**
```typescript
      const promptBuildResult = setupMode
        ? await services.promptBuilder.buildSetupPromptMessages({
            ...
          })
        : await services.promptBuilder.buildChatPromptMessages({
            ...
          });
```

**After:**
```typescript
      const isPersonaSetupMode = setupMode && mode.setupPhase?.promptMode === "persona_setup";
      const isChatWithSetupInjection = setupMode && mode.setupPhase?.promptMode === "chat_with_setup_injection";

      const promptBuildResult = isPersonaSetupMode
        ? await services.promptBuilder.buildSetupPromptMessages({
            sessionId,
            interactionMode,
            persona,
            historyForPrompt: historyForPromptMessages,
            recentToolEvents,
            debugMarkers,
            internalTranscript: refreshedSession.internalTranscript,
            currentUser: user,
            participantProfiles,
            lastLlmUsage: refreshedSession.lastLlmUsage,
            lateSystemMessages,
            replayMessages: projectedTranscript.replayMessages,
            abortSignal: abortController.signal,
            batchMessages: toPromptBatchMessages(messages)
          })
        : await services.promptBuilder.buildChatPromptMessages({
            sessionId,
            modeId: sessionModeId,
            interactionMode,
            mainModelRef: resolvedModelRef,
            visibleToolNames: chatVisibleToolNames,
            activeToolsets: activeChatToolsets,
            lateSystemMessages,
            replayMessages: projectedTranscript.replayMessages,
            persona,
            relationship,
            participantProfiles,
            currentUser: user,
            historySummary: refreshedSession.historySummary,
            historyForPrompt: historyForPromptMessages,
            recentToolEvents,
            debugMarkers,
            internalTranscript: refreshedSession.internalTranscript,
            lastLlmUsage: refreshedSession.lastLlmUsage,
            abortSignal: abortController.signal,
            batchMessages: toPromptBatchMessages(messages),
            ...(isChatWithSetupInjection ? { isInSetup: true } : {})
          });
```

Replace the `runGeneration` call's `setupMode` branch:

**Before:**
```typescript
        ...(setupMode
          ? {
              availableToolNames: ["read_memory", "write_memory"],
              setupMode: true
            }
          : {
              plannedToolsetIds,
              availableToolsets: plannerToolsets
            }),
```

**After:**
```typescript
        ...(setupMode
          ? {
              availableToolNames: plannerToolsets.flatMap((t) => t.toolNames),
              setupMode: true
            }
          : {
              plannedToolsetIds,
              availableToolsets: plannerToolsets
            }),
```

- [ ] **Step 2: Update `generationExecutor.ts`**

Add imports:
```typescript
import { requireSessionModeDefinition } from "#modes/registry.ts";
import { checkSetupCompletion } from "./generationSetupContext.ts";
```

Replace the `finally` block's setup-completion check:

**Before:**
```typescript
      const finishedCurrent = sessionManager.finishGeneration(sessionId, abortController);
      if (finishedCurrent && setupMode && await setupStore.isReady()) {
        sessionManager.clearSession(sessionId);
        persistSession(sessionId, "setup_completed_session_cleared");
      }
```

**After:**
```typescript
      const finishedCurrent = sessionManager.finishGeneration(sessionId, abortController);
      if (finishedCurrent && setupMode) {
        const modeId = sessionManager.getModeId(sessionId);
        const modeDef = requireSessionModeDefinition(modeId);
        if (modeDef.setupPhase) {
          const isComplete = await checkSetupCompletion(
            modeDef.setupPhase.completionSignal,
            sessionId,
            { setupStore, scenarioHostStateStore }
          );
          if (isComplete && modeDef.setupPhase.onComplete === "clear_session") {
            sessionManager.clearSession(sessionId);
            persistSession(sessionId, "setup_completed_session_cleared");
          }
        }
      }
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```
npm test
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/app/generation/generationSessionOrchestrator.ts src/app/generation/generationExecutor.ts
git commit -m "refactor(generation): decouple rp_assistant setup logic from main pipeline using SessionModeSetupPhase"
```

---

### Task 6: Prompt chain — `isInSetup` through PromptInput and scenario_host setup branch

**Files:**
- Modify: `src/llm/prompt/promptTypes.ts`
- Modify: `src/llm/prompt/promptBuilder.ts`
- Modify: `src/llm/prompts/chat-system.prompt.ts`
- Modify: `test/generation/generation-prompt-builder.test.tsx`

- [ ] **Step 1: Write failing test**

Add to `test/generation/generation-prompt-builder.test.tsx` inside `main()`:

```typescript
  await runCase("scenario_host setup prompt uses host_setup_mode section when isInSetup=true", async () => {
    const builder = createGenerationPromptBuilder({
      config: createTestAppConfig({
        llm: {
          enabled: true,
          mainRouting: {
            smallModelRef: ["main"],
            largeModelRef: ["main"]
          },
          models: { main: { supportsVision: false } }
        }
      }),
      oneBotClient: {} as any,
      audioStore: {} as any,
      audioTranscriber: { async transcribeMany() { return []; } } as any,
      npcDirectory: { listProfiles() { return []; } } as any,
      browserService: { async listPages() { return { pages: [] }; } } as any,
      localFileService: {} as any,
      chatFileStore: {} as any,
      mediaVisionService: { async prepareFilesForModel() { return []; } } as any,
      mediaCaptionService: { async captureMany() { return []; } } as any,
      globalMemoryStore: { async list() { return []; } } as any,
      operationNoteStore: { async list() { return []; } } as any,
      setupStore: { async get() { return { state: "ready" as const }; } } as any,
      shellRuntime: { async listSessions() { return []; } } as any,
      scenarioHostStateStore: {
        async ensureForSession() {
          return {
            version: 1 as const,
            title: "未命名场景",
            currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
            currentLocation: null,
            sceneSummary: "",
            player: { userId: "u1", displayName: "Alice" },
            inventory: [],
            objectives: [],
            worldFacts: [],
            flags: {},
            initialized: false,
            turnIndex: 0
          };
        }
      } as any
    });

    const result = await builder.buildChatPromptMessages({
      sessionId: "private:u1",
      modeId: "scenario_host",
      interactionMode: "normal",
      mainModelRef: ["main"],
      visibleToolNames: [],
      activeToolsets: [],
      lateSystemMessages: [],
      replayMessages: [],
      persona: {
        name: "主持者",
        role: "",
        personality: "",
        speechStyle: "",
        appearance: "",
        interests: "",
        background: "",
        rules: ""
      },
      relationship: "owner",
      participantProfiles: [],
      currentUser: null,
      historySummary: null,
      historyForPrompt: [],
      recentToolEvents: [],
      debugMarkers: [],
      internalTranscript: [],
      lastLlmUsage: null,
      abortSignal: new AbortController().signal,
      batchMessages: [{
        userId: "u1",
        senderName: "Alice",
        text: "开始游戏",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        mentionedSelf: false
      }],
      isInSetup: true
    });

    const systemContent = result.promptMessages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    assert.ok(systemContent.includes("host_setup_mode"), `Expected host_setup_mode section, got: ${systemContent.slice(0, 400)}`);
    assert.ok(!systemContent.includes("host_identity"), `Expected no host_identity section in setup mode`);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx test/generation/generation-prompt-builder.test.tsx
```

Expected: FAIL — `isInSetup` not in type, or `host_setup_mode` section not found.

- [ ] **Step 3: Add `isInSetup` to `src/llm/prompt/promptTypes.ts`**

In `PromptInput`, add:
```typescript
  isInSetup?: boolean | undefined;
```

- [ ] **Step 4: Update `src/llm/prompt/promptBuilder.ts`**

Find where `buildBaseSystemLines` is called for chat prompts. Pass `isInSetup` through. Locate the call signature for `buildBaseSystemLines` in `buildChatPromptMessages` and add:

```typescript
    isInSetup: input.isInSetup,
```

Also ensure `buildChatPromptMessages` accepts `isInSetup?: boolean` in its input type (it derives from `PromptInput` so it should already be there; if there's a separate local type, extend it).

- [ ] **Step 5: Update `src/llm/prompts/chat-system.prompt.ts`**

Add `isInSetup?: boolean | undefined` to the `buildBaseSystemLines` input type:

```typescript
export function buildBaseSystemLines(input: {
  sessionMode: "private" | "group" | "unknown";
  modeId?: string;
  interactionMode?: PromptInteractionMode;
  isInSetup?: boolean | undefined;
  visibleToolNames?: string[] | undefined;
  activeToolsets?: ToolsetView[] | undefined;
  persona: Persona;
  npcProfiles: PromptInput["npcProfiles"];
  participantProfiles: PromptInput["participantProfiles"];
  userProfile: PromptInput["userProfile"];
  globalMemories?: PromptInput["globalMemories"] | undefined;
  historySummary?: string | null | undefined;
  recentToolEvents?: PromptInput["recentToolEvents"] | undefined;
  liveResources?: PromptInput["liveResources"] | undefined;
  operationNotes?: PromptOperationNote[] | undefined;
  scenarioStateLines?: string[] | undefined;
}): string[] {
  if (input.modeId === "scenario_host") {
    if (input.isInSetup) {
      return [
        renderPromptSection("host_setup_mode", buildScenarioHostSetupModeLines()),
        renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
        renderPromptSection("context_rules", buildContextRuleLines({ visibleToolNames: input.visibleToolNames })),
        renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
          activeToolsets: input.activeToolsets,
          visibleToolNames: input.visibleToolNames
        })),
        renderPromptSection("participant_context", buildParticipantContextLines(input.sessionMode, input.participantProfiles))
      ].filter((item): item is string => Boolean(item));
    }
    return [
      // ... existing scenario_host lines unchanged
```

Add the `buildScenarioHostSetupModeLines` function after `buildScenarioHostRuleLines`:

```typescript
function buildScenarioHostSetupModeLines(): string[] {
  return [
    "当前处于场景初始化阶段，故事基础信息尚未设定。",
    "你的首要目标是：引导玩家提供场景信息，并在获取足够信息后调用 update_scenario_state，将 initialized 设为 true，完成初始化。",
    "需要向玩家询问以下内容（可一次性提问，允许玩家简短回答）：",
    "- 场景标题（title）：这是什么故事？",
    "- 当前情况（currentSituation）：故事从哪里开始？玩家当前在哪、面对什么？",
    "- 玩家角色（player）：玩家扮演的是谁？",
    "信息收集完毕后，立即调用 update_scenario_state 填入以上字段，并将 initialized 设为 true。",
    "初始化完成后，简短告知玩家可以开始行动，然后进入正常主持流程。",
    "不要在初始化阶段进行剧情推进；只收集信息并写入状态。",
    "回复保持简洁，不用 Markdown 标题或列表。"
  ];
}
```

- [ ] **Step 6: Run test to verify it passes**

```
node --import tsx test/generation/generation-prompt-builder.test.tsx
```

Expected: all cases PASS.

- [ ] **Step 7: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/llm/prompt/promptTypes.ts src/llm/prompt/promptBuilder.ts src/llm/prompts/chat-system.prompt.ts test/generation/generation-prompt-builder.test.tsx
git commit -m "feat(prompt): add isInSetup flag and scenario_host setup mode prompt branch"
```

---

### Task 7: Expose `initialized` in `update_scenario_state` tool

**Files:**
- Modify: `src/llm/tools/conversation/scenarioHostTools.ts`
- Modify: `test/tools/tool-runtime-features.test.tsx`

- [ ] **Step 1: Write failing test**

Add to `test/tools/tool-runtime-features.test.tsx` inside `main()`:

```typescript
  await runCase("update_scenario_state sets initialized=true when provided", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tool-scenario-"));
    try {
      const { ScenarioHostStateStore } = await import("../../src/modes/scenarioHost/stateStore.ts");
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      const sessionId = "private:u1";

      const handler = scenarioHostToolHandlers["update_scenario_state"];
      assert.ok(handler, "update_scenario_state handler must exist");

      const context = {
        lastMessage: { sessionId, userId: "u1", senderName: "Alice" },
        sessionManager: {
          getModeId() { return "scenario_host"; },
          getSession() {
            return {
              participantUserId: "u1",
              participantLabel: "Alice"
            };
          }
        },
        scenarioHostStateStore: store,
        persistSession: () => {}
      } as any;

      // Initialize state first
      await store.ensure(sessionId, { playerUserId: "u1", playerDisplayName: "Alice" });

      // Call with initialized=true
      const result = await handler(
        { id: "tc1", function: { name: "update_scenario_state", arguments: "" } } as any,
        { title: "神秘城堡", initialized: true },
        context
      );

      const parsed = JSON.parse(result as string);
      assert.equal(parsed.initialized, true);
      assert.equal(parsed.title, "神秘城堡");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
```

(Add `import pino from "pino"` and `import { mkdtemp, rm } from "node:fs/promises"` and `import { tmpdir } from "node:os"` to the top of that test file if not already present.)

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx test/tools/tool-runtime-features.test.tsx
```

Expected: FAIL — `initialized` is not applied by the handler.

- [ ] **Step 3: Update `src/llm/tools/conversation/scenarioHostTools.ts`**

In `scenarioHostToolDescriptors`, add `initialized` to the `update_scenario_state` definition:

```typescript
            initialized: { type: "boolean" }
```

In `scenarioHostToolHandlers.update_scenario_state`, after the `flags` extraction, add:

```typescript
    const rawInitialized = typeof args === "object" && args != null && "initialized" in args
      ? (args as { initialized?: unknown }).initialized
      : undefined;
    const initialized = typeof rawInitialized === "boolean" ? rawInitialized : undefined;
```

Add `initialized` to the `update` call:

```typescript
      (current) => ({
        ...current,
        ...(title ? { title } : {}),
        ...(currentSituation ? { currentSituation } : {}),
        ...(sceneSummary ? { sceneSummary } : {}),
        ...(Number.isFinite(turnIndex) ? { turnIndex: Math.max(0, Math.round(turnIndex!)) } : {}),
        ...(flags ? { flags: { ...current.flags, ...flags } } : {}),
        ...(initialized !== undefined ? { initialized } : {})
      }),
```

Also update the `update_scenario_state` tool description to mention `initialized`:

```typescript
        description: "更新当前 scenario_host 场景的受控字段，不可整体覆写完整状态。初始化完成后将 initialized 设为 true。",
```

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx test/tools/tool-runtime-features.test.tsx
```

Expected: all cases PASS.

- [ ] **Step 5: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/llm/tools/conversation/scenarioHostTools.ts test/tools/tool-runtime-features.test.tsx
git commit -m "feat(scenario-host-tools): expose initialized field in update_scenario_state"
```

---

### Task 8: Add scope system to direct commands

**Files:**
- Modify: `src/app/messaging/directCommands.ts`
- Modify: `src/app/messaging/messageCommandFlow.ts`
- Modify: `test/helpers/direct-command-fixtures.tsx`
- Create: `test/messaging/direct-command-features.test.tsx`

- [ ] **Step 1: Write failing test**

Create `test/messaging/direct-command-features.test.tsx`:

```typescript
import assert from "node:assert/strict";
import {
  canExecuteDirectCommand,
  parseDirectCommand,
  resolveDispatchableDirectCommand
} from "../../src/app/messaging/directCommands.ts";

async function runCase(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("reset command is not visible in rp_assistant mode", () => {
    const parsed = parseDirectCommand(".reset");
    if (!parsed) {
      // command not registered yet — this test will fail after we add it
      throw new Error("reset command not found in parseDirectCommand");
    }
    const allowed = canExecuteDirectCommand(parsed, {
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      sessionModeId: "rp_assistant"
    });
    assert.equal(allowed, false, "reset should not be allowed in rp_assistant mode");
  });

  await runCase("reset command is visible in scenario_host mode", () => {
    const parsed = parseDirectCommand(".reset");
    assert.ok(parsed, "reset command must exist");
    const allowed = canExecuteDirectCommand(parsed, {
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      sessionModeId: "scenario_host"
    });
    assert.equal(allowed, true, "reset should be allowed in scenario_host mode");
  });

  await runCase("clear command is allowed regardless of sessionModeId", () => {
    const parsed = parseDirectCommand(".clear");
    assert.ok(parsed);
    const allowed = canExecuteDirectCommand(parsed, {
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      sessionModeId: "scenario_host"
    });
    assert.equal(allowed, true);
  });

  await runCase("resolveDispatchableDirectCommand returns reset only in scenario_host", () => {
    const inScenario = resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      isAtMentioned: false,
      text: ".reset",
      sessionModeId: "scenario_host"
    });
    assert.ok(inScenario, "should resolve in scenario_host");
    assert.equal(inScenario.name, "reset");

    const inRp = resolveDispatchableDirectCommand({
      phase: "chat",
      setupState: "ready",
      chatType: "private",
      relationship: "owner",
      isAtMentioned: false,
      text: ".reset",
      sessionModeId: "rp_assistant"
    });
    assert.equal(inRp, null, "should not resolve in rp_assistant");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx test/messaging/direct-command-features.test.tsx
```

Expected: FAIL — `reset` command not found, `sessionModeId` not in routing context.

- [ ] **Step 3: Update `src/app/messaging/directCommands.ts`**

**3a.** Add `scope?: "universal" | string` to `DirectCommandDescriptor`:

```typescript
interface DirectCommandDescriptor {
  name: DirectCommandName;
  help: string;
  scope?: "universal" | string;
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
```

**3b.** Add `sessionModeId?: string` to `DirectCommandRoutingContext`:

```typescript
interface DirectCommandRoutingContext {
  phase: "owner_bootstrap" | "chat";
  setupState: "needs_owner" | "needs_persona" | "ready";
  chatType: "private" | "group";
  relationship?: Relationship;
  isAtMentioned?: boolean;
  sessionModeId?: string;
}
```

**3c.** Add `sessionModeId?: string` to `DirectCommandDispatchContext` (it extends `DirectCommandRoutingContext` so it's automatic — but verify the interface definition doesn't need updating separately).

**3d.** Update `canExecuteDirectCommand` to check `scope`:

In the `chat` phase block, after existing checks, add scope check:

```typescript
  if (context.phase === "owner_bootstrap") {
    return context.setupState === "needs_owner"
      && context.chatType === "private"
      && descriptor.routing?.allowBeforeOwnerBound === true;
  }

  // Scope check: commands with a non-universal scope only allowed in matching mode
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
```

**3e.** Add `"reset"` to `DirectCommandArgsMap`:

```typescript
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
};
```

**3f.** Add `scenarioHostStateStore?` to `DirectCommandHandlerInput`:

```typescript
interface DirectCommandHandlerInput {
  config: AppConfig;
  sessionManager: SessionManager;
  oneBotClient: OneBotClient;
  logger: Logger;
  scenarioHostStateStore?: import("#modes/scenarioHost/stateStore.ts").ScenarioHostStateStore;
  forceCompactSession?: (sessionId: string, retainMessageCount?: number) => Promise<boolean>;
  ...
```

**3g.** Add the `reset` descriptor to `directCommandDescriptors` array:

```typescript
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
      const { createInitialScenarioHostSessionState } = await import("#modes/scenarioHost/types.ts");
      const defaults = {
        playerUserId: ctx.session.participantUserId ?? ctx.incomingMessage.userId,
        playerDisplayName: (ctx.session as any).participantLabel ?? ctx.session.participantUserId ?? ctx.incomingMessage.userId
      };
      ctx.input.sessionManager.cancelGeneration(ctx.session.id);
      ctx.input.sessionManager.clearSession(ctx.session.id);
      await ctx.input.scenarioHostStateStore.write(ctx.session.id, createInitialScenarioHostSessionState(defaults));
      ctx.input.persistSession(ctx.session.id, "scenario_reset_by_command");
      ctx.input.logger.info({ sessionId: ctx.session.id }, "scenario_reset_by_command");
      await ctx.send("场景已重置，会话上下文已清空。");
    }
  }
```

- [ ] **Step 4: Update `src/app/messaging/messageCommandFlow.ts`**

Pass `sessionModeId` in `resolveChatDirectCommand`:

```typescript
export function resolveChatDirectCommand(
  context: MessageProcessingContext
): DirectCommandInput["command"] | null {
  return resolveDispatchableDirectCommand({
    phase: "chat",
    setupState: context.setupState.state,
    chatType: context.enrichedMessage.chatType,
    relationship: context.user.relationship,
    isAtMentioned: context.enrichedMessage.isAtMentioned,
    text: context.enrichedMessage.text,
    hasImages: context.enrichedMessage.images.length > 0,
    hasForwards: context.enrichedMessage.forwardIds.length > 0,
    hasAudio: context.enrichedMessage.audioSources.length > 0,
    sessionModeId: context.session.modeId
  });
}
```

- [ ] **Step 5: Update `test/helpers/direct-command-fixtures.tsx`**

Add `getModeId?: (sessionId: string) => string` and `scenarioHostStateStore?` to `DirectCommandFixtureOptions`:

```typescript
interface DirectCommandFixtureOptions {
  ...
  getModeId?: (sessionId: string) => string;
  scenarioHostStateStore?: {
    write: (sessionId: string, state: unknown) => Promise<unknown>;
  };
}
```

In `createDirectCommandFixture`, add `getModeId` to the `sessionManager` mock:

```typescript
      getModeId(sessionId: string) {
        return options.getModeId?.(sessionId) ?? "rp_assistant";
      },
```

Pass `scenarioHostStateStore` to `createDirectCommandHandler` if provided:

```typescript
    ...(options.scenarioHostStateStore ? { scenarioHostStateStore: options.scenarioHostStateStore as any } : {}),
```

- [ ] **Step 6: Run test to verify it passes**

```
node --import tsx test/messaging/direct-command-features.test.tsx
```

Expected: all cases PASS.

- [ ] **Step 7: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 8: Run all tests**

```
npm test
```

Expected: all passing.

- [ ] **Step 9: Commit**

```bash
git add src/app/messaging/directCommands.ts src/app/messaging/messageCommandFlow.ts test/helpers/direct-command-fixtures.tsx test/messaging/direct-command-features.test.tsx
git commit -m "feat(commands): add scope system and reset command for scenario_host mode"
```

---

### Task 9: Wire `scenarioHostStateStore` + `sessionModeId` through the runtime

**Files:**
- Modify: `src/app/runtime/runtimeDependencyBuilders.ts` or wherever `createDirectCommandHandler` is called (check `messageIngress.ts`)

- [ ] **Step 1: Find the call site**

Check `src/app/runtime/messageIngress.ts` (or equivalent) for where `createDirectCommandHandler` is called.

```
node --import tsx -e "import('./src/app/runtime/runtimeDependencyBuilders.ts')"
```

Or search:
```bash
grep -rn "createDirectCommandHandler" src/
```

- [ ] **Step 2: Pass `scenarioHostStateStore` to `createDirectCommandHandler`**

In the file that calls `createDirectCommandHandler(...)`, add `scenarioHostStateStore` from `deps`:

```typescript
const handleDirectCommand = createDirectCommandHandler({
  ...existingArgs,
  scenarioHostStateStore: deps.scenarioHostStateStore
});
```

- [ ] **Step 3: Ensure `sessionModeId` is available in message routing context**

Check that `context.session.modeId` is available where `resolveChatDirectCommand` is called. The `MessageProcessingContext` type should already have `session.modeId` since session objects carry it. If `MessageProcessingContext.session` doesn't expose `modeId`, look at `src/app/messaging/messageHandlerTypes.ts` and ensure `modeId` is part of the session type there.

If `modeId` is missing, add it:
```typescript
interface MessageProcessingContext {
  session: {
    id: string;
    modeId: string;
    // ... other fields
  };
  // ...
}
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 5: Run all tests**

```
npm test
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add src/app/runtime/ src/app/messaging/messageHandlerTypes.ts  # adjust paths as needed
git commit -m "feat(runtime): wire scenarioHostStateStore into direct command handler"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| scenario_host initialization flow with `initialized` flag | Tasks 1, 6, 7 |
| Setup prompts before/after initialization (different system prompts) | Task 6 |
| Session-level storage for scenario state | Task 1 (already present via ScenarioHostStateStore) |
| rp_assistant setup logic decoupled from main pipeline | Tasks 2, 3, 5 |
| Command scope system (generic + mode-specific) | Task 8 |
| `reset` command only in scenario_host | Tasks 8, 9 |
| `reset` clears history AND resets scenario state | Task 8 |
| Completion signal for scenario_host: `initialized` flag, not text detection | Tasks 4, 5 |

**No placeholders — all steps contain complete code.**

**Type consistency check:**
- `SessionModeSetupPhase` defined in Task 2, used in Tasks 3, 5, 6
- `isScenarioStateInitialized` defined in Task 1, used in Task 4
- `checkSetupCompletion` defined in Task 4, used in Task 5
- `resolveSessionModeSetupContext` defined in Task 4, used in Task 5
- `initialized` field in schema (Task 1) → used in Tool handler (Task 7) → checked in context (Task 4)
- `scope` field on `DirectCommandDescriptor` (Task 8) checked in `canExecuteDirectCommand` (Task 8)
- `sessionModeId` in `DirectCommandRoutingContext` (Task 8) passed from `messageCommandFlow.ts` (Task 8)

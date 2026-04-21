# Global Persona And Mode Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将单层 persona / setup 体系重构为全局 `persona`、全局 `rpProfile`、全局 `scenarioProfile`、全局 readiness 和会话级配置工作态，并让 setup/config 全程基于临时草稿运行。

**Architecture:** 以“全局资料 + 全局 readiness + 会话工作态 + 会话草稿”四层模型替代当前单一 `setupState`。模式入口、工具可见性、prompt 选择、命令流和 WebUI 展示都统一改为基于 `persona.ready`、模式 profile readiness 和当前 `operationMode` 判断。

**Tech Stack:** Node.js 20、TypeScript、Node test runner、Vue 3 WebUI、现有 `FileSchemaStore` / session runtime / toolset selection 机制

---

## 文件结构

### 新建文件

- `src/identity/globalProfileReadinessSchema.ts`
  - 定义 `persona/rp/scenario` 三段 readiness schema。
- `src/identity/globalProfileReadinessStore.ts`
  - 持久化全局 readiness，替代现有 setup readiness 语义。
- `src/modes/rpAssistant/profileSchema.ts`
  - 定义全局 `rpProfile` 结构。
- `src/modes/rpAssistant/profileStore.ts`
  - 持久化 `rpProfile`。
- `src/modes/scenarioHost/profileSchema.ts`
  - 定义全局 `scenarioProfile` 结构。
- `src/modes/scenarioHost/profileStore.ts`
  - 持久化 `scenarioProfile`。
- `src/conversation/session/sessionOperationMode.ts`
  - 定义会话工作态、草稿载荷、判定工具函数。

### 重点修改文件

- `src/persona/personaSchema.ts`
- `src/persona/personaStore.ts`
- `src/identity/setupStateSchema.ts`
- `src/identity/setupStateStore.ts`
- `src/app/bootstrap/bootstrapServices.ts`
- `src/app/bootstrap/appSetupSupport.ts`
- `src/app/messaging/messageEventHandler.ts`
- `src/app/messaging/messageContextBuilder.ts`
- `src/app/messaging/messageHandlerTypes.ts`
- `src/app/messaging/messageAdmission.ts`
- `src/app/messaging/messageSetupFlow.ts`
- `src/app/messaging/directCommands.ts`
- `src/app/generation/generationSetupContext.ts`
- `src/app/generation/generationSessionOrchestrator.ts`
- `src/llm/prompts/chat-system.prompt.ts`
- `src/llm/tools/profile/profileTools.ts`
- `src/llm/tools/toolsetCatalog.ts`
- `src/llm/tools/toolsetSelectionPolicy.ts`
- `src/modes/types.ts`
- `src/modes/rpAssistantMode.ts`
- `src/modes/scenarioHost/mode.ts`
- `src/conversation/session/sessionTypes.ts`
- `src/conversation/session/sessionStateFactory.ts`
- `src/conversation/session/sessionCapabilities.ts`
- `src/conversation/session/sessionManager.ts`
- `src/conversation/session/sessionMutations.ts`
- `src/conversation/session/sessionPersistence.ts`
- `src/internalApi/application/editorService.ts`
- `src/internalApi/application/webSessionStream.ts`
- `webui/src/stores/sessions.ts`
- `webui/src/stores/sessionDisplay.ts`
- `webui/src/composables/sections/useSessionsSection.ts`
- `README.md`

### 重点测试文件

- `test/memory/memory-storage-features.test.tsx`
- `test/messaging/direct-command-features.test.tsx`
- `test/generation/toolset-selection-policy.test.tsx`
- `test/generation/generation-prompt-builder.test.tsx`
- `test/tools/tool-runtime-features.test.tsx`
- `test/session/persistence.test.tsx`
- `test/webui/session-display.test.ts`

## Task 1: 重建全局资料与 readiness 存储

**Files:**
- Create: `src/identity/globalProfileReadinessSchema.ts`
- Create: `src/identity/globalProfileReadinessStore.ts`
- Create: `src/modes/rpAssistant/profileSchema.ts`
- Create: `src/modes/rpAssistant/profileStore.ts`
- Create: `src/modes/scenarioHost/profileSchema.ts`
- Create: `src/modes/scenarioHost/profileStore.ts`
- Modify: `src/persona/personaSchema.ts`
- Modify: `src/persona/personaStore.ts`
- Modify: `test/memory/memory-storage-features.test.tsx`

- [ ] **Step 1: 先写失败测试，锁定新 schema/store 语义**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyPersona, isPersonaComplete } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile, isRpProfileComplete } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile, isScenarioProfileComplete } from "../../src/modes/scenarioHost/profileSchema.ts";
import { GlobalProfileReadinessStore } from "../../src/identity/globalProfileReadinessStore.ts";

test("persona completeness only depends on global persona fields", async () => {
  const persona = createEmptyPersona();
  assert.equal(isPersonaComplete(persona), false);
  persona.name = "Mina";
  persona.coreIdentity = "独立创作者";
  persona.personality = "冷静、克制";
  persona.speechStyle = "短句、直说";
  assert.equal(isPersonaComplete(persona), true);
});

test("rp profile completeness requires premise identityBoundary hardRules", async () => {
  const rp = createEmptyRpProfile();
  assert.equal(isRpProfileComplete(rp), false);
  rp.premise = "以现实同居关系开场";
  rp.identityBoundary = "始终按真人自处";
  rp.hardRules = "不承认自己是模型";
  assert.equal(isRpProfileComplete(rp), true);
});

test("global readiness store persists three profile readiness flags", async () => {
  const store = new GlobalProfileReadinessStore(dataDir, logger);
  await store.write({ persona: "ready", rp: "uninitialized", scenario: "ready", updatedAt: 1 });
  assert.deepEqual(await store.get(), {
    persona: "ready",
    rp: "uninitialized",
    scenario: "ready",
    updatedAt: 1
  });
});
```

- [ ] **Step 2: 跑单测确认当前实现无法满足**

Run: `node test/run-node-tests.mjs test/memory/memory-storage-features.test.tsx`
Expected: FAIL，报出 `coreIdentity` / `GlobalProfileReadinessStore` / `rpProfile` 相关导出不存在。

- [ ] **Step 3: 实现新 schema/store，并收紧 persona 字段**

```ts
// src/persona/personaSchema.ts
export const personaSchema = s.object({
  name: personaFieldSchema,
  coreIdentity: personaFieldSchema,
  personality: personaFieldSchema,
  interests: personaFieldSchema,
  background: personaFieldSchema,
  speechStyle: personaFieldSchema
}).strict();

export function getMissingPersonaFields(persona: Persona): EditablePersonaFieldName[] {
  return ["name", "coreIdentity", "personality", "speechStyle"].filter((field) => !persona[field].trim());
}
```

```ts
// src/modes/rpAssistant/profileSchema.ts
export const rpProfileSchema = s.object({
  appearance: s.string().default(""),
  premise: s.string().default(""),
  relationship: s.string().default(""),
  identityBoundary: s.string().default(""),
  styleRules: s.string().default(""),
  hardRules: s.string().default("")
}).strict();
```

```ts
// src/identity/globalProfileReadinessSchema.ts
export const globalProfileReadinessSchema = s.object({
  persona: s.enum(["uninitialized", "ready"] as const),
  rp: s.enum(["uninitialized", "ready"] as const),
  scenario: s.enum(["uninitialized", "ready"] as const),
  updatedAt: s.number().int().min(0)
}).strict();
```

- [ ] **Step 4: 重新跑存储测试**

Run: `node test/run-node-tests.mjs test/memory/memory-storage-features.test.tsx`
Expected: PASS，三段 readiness 与三套 profile completeness 判定通过。

- [ ] **Step 5: 提交存储模型变更**

```bash
git add \
  src/persona/personaSchema.ts \
  src/persona/personaStore.ts \
  src/identity/globalProfileReadinessSchema.ts \
  src/identity/globalProfileReadinessStore.ts \
  src/modes/rpAssistant/profileSchema.ts \
  src/modes/rpAssistant/profileStore.ts \
  src/modes/scenarioHost/profileSchema.ts \
  src/modes/scenarioHost/profileStore.ts \
  test/memory/memory-storage-features.test.tsx
git commit -m "refactor: split persona and mode profile storage"
```

## Task 2: 为 session 引入工作态与临时草稿

**Files:**
- Create: `src/conversation/session/sessionOperationMode.ts`
- Modify: `src/conversation/session/sessionTypes.ts`
- Modify: `src/conversation/session/sessionStateFactory.ts`
- Modify: `src/conversation/session/sessionCapabilities.ts`
- Modify: `src/conversation/session/sessionManager.ts`
- Modify: `src/conversation/session/sessionMutations.ts`
- Modify: `src/conversation/session/sessionPersistence.ts`
- Modify: `test/session/persistence.test.tsx`

- [ ] **Step 1: 先写失败测试，约束 session 的 operationMode 与 draft 持久化**

```ts
test("persisted session stores operation mode and draft payload", () => {
  const session = createSessionState({
    id: "qqbot:p:test",
    type: "private",
    modeId: "rp_assistant"
  });

  session.operationMode = {
    kind: "mode_config",
    modeId: "rp_assistant",
    draft: {
      appearance: "黑发",
      premise: "同居恋人",
      relationship: "",
      identityBoundary: "",
      styleRules: "",
      hardRules: ""
    }
  };

  const persisted = toPersistedSessionState(session);
  assert.equal(persisted.operationMode?.kind, "mode_config");
  assert.equal(persisted.operationMode?.modeId, "rp_assistant");
});

test("clearSessionState resets operationMode to normal", () => {
  const session = createSessionState({ id: "qqbot:p:test", type: "private", modeId: "assistant" });
  session.operationMode = { kind: "persona_config", draft: createEmptyPersona() };
  clearSessionState(session);
  assert.deepEqual(session.operationMode, { kind: "normal" });
});
```

- [ ] **Step 2: 跑 session 持久化测试，确认当前 session contract 不含 operationMode**

Run: `node test/run-node-tests.mjs test/session/persistence.test.tsx`
Expected: FAIL，提示 `operationMode` 字段不存在或未持久化。

- [ ] **Step 3: 实现 operationMode 类型、session 字段和持久化**

```ts
// src/conversation/session/sessionOperationMode.ts
export type SessionOperationMode =
  | { kind: "normal" }
  | { kind: "persona_setup"; draft: Persona }
  | { kind: "mode_setup"; modeId: "rp_assistant" | "scenario_host"; draft: RpProfile | ScenarioProfile }
  | { kind: "persona_config"; draft: Persona }
  | { kind: "mode_config"; modeId: "rp_assistant" | "scenario_host"; draft: RpProfile | ScenarioProfile };

export function isSessionInConfiguration(mode: SessionOperationMode): boolean {
  return mode.kind !== "normal";
}
```

```ts
// src/conversation/session/sessionTypes.ts
export interface SessionState {
  // ...
  operationMode: SessionOperationMode;
}

export interface PersistedSessionState {
  // ...
  operationMode?: SessionOperationMode;
}
```

```ts
// src/conversation/session/sessionManager.ts
setOperationMode(sessionId: string, operationMode: SessionOperationMode): void {
  const session = this.requireSession(sessionId);
  session.operationMode = operationMode;
  session.lastActiveAt = Date.now();
  this.notifySessionChanged(sessionId);
}
```

- [ ] **Step 4: 重新跑 session 持久化测试**

Run: `node test/run-node-tests.mjs test/session/persistence.test.tsx`
Expected: PASS，`operationMode` 可持久化且 `clearSessionState()` 会复位到 `normal`。

- [ ] **Step 5: 提交 session 工作态变更**

```bash
git add \
  src/conversation/session/sessionOperationMode.ts \
  src/conversation/session/sessionTypes.ts \
  src/conversation/session/sessionStateFactory.ts \
  src/conversation/session/sessionCapabilities.ts \
  src/conversation/session/sessionManager.ts \
  src/conversation/session/sessionMutations.ts \
  src/conversation/session/sessionPersistence.ts \
  test/session/persistence.test.tsx
git commit -m "feat: add session operation mode and drafts"
```

## Task 3: 用 readiness + operationMode 重写模式 setup 判定

**Files:**
- Modify: `src/modes/types.ts`
- Modify: `src/modes/rpAssistantMode.ts`
- Modify: `src/modes/scenarioHost/mode.ts`
- Modify: `src/app/generation/generationSetupContext.ts`
- Modify: `src/app/generation/generationSessionOrchestrator.ts`
- Modify: `src/app/bootstrap/bootstrapServices.ts`
- Modify: `test/generation/toolset-selection-policy.test.tsx`
- Modify: `test/generation/generation-prompt-builder.test.tsx`

- [ ] **Step 1: 先写失败测试，约束 persona 优先、模式 profile 次级依赖**

```ts
test("rp assistant enters persona setup before rp setup when persona is uninitialized", async () => {
  const ctx = await resolveSessionModeSetupContext("rp_assistant", "qqbot:p:test", deps, {
    chatType: "private",
    relationship: "owner"
  });
  assert.equal(ctx.personaReady, false);
  assert.equal(ctx.modeProfileReady, false);
  assert.equal(rpAssistantModeDefinition.setupPhase?.resolveOperation(ctx).kind, "persona_setup");
});

test("scenario enters mode_setup only after persona is ready", async () => {
  const ctx = { personaReady: true, modeProfileReady: false, operationMode: { kind: "normal" }, chatType: "private", relationship: "owner" };
  assert.equal(scenarioHostModeDefinition.setupPhase?.resolveOperation(ctx).kind, "mode_setup");
});
```

- [ ] **Step 2: 跑 generation/toolset 相关测试确认旧 setupContext 不足**

Run: `node test/run-node-tests.mjs test/generation/toolset-selection-policy.test.tsx test/generation/generation-prompt-builder.test.tsx`
Expected: FAIL，旧 `globalSetupReady` / `setupConfirmedByUser` 结构与新断言不匹配。

- [ ] **Step 3: 重构 mode setup contract 为“解析目标工作态”**

```ts
// src/modes/types.ts
export interface SessionModeSetupContext {
  personaReady: boolean;
  modeProfileReady: boolean;
  operationMode: SessionOperationMode;
  chatType: "private" | "group";
  relationship: string;
}

export interface SessionModeSetupPhase {
  resolveOperation(ctx: SessionModeSetupContext): SessionOperationMode["kind"] | null;
  setupToolsetOverridesByMode: Record<"persona_setup" | "mode_setup" | "persona_config" | "mode_config", SessionModeSetupToolsetOverride[]>;
  promptMode: "persona_setup" | "mode_setup" | "persona_config" | "mode_config";
}
```

```ts
// src/modes/rpAssistantMode.ts
resolveOperation({ personaReady, modeProfileReady, operationMode, chatType, relationship }) {
  if (operationMode.kind !== "normal") {
    return operationMode.kind;
  }
  if (chatType !== "private" || relationship !== "owner") {
    return null;
  }
  if (!personaReady) {
    return "persona_setup";
  }
  return modeProfileReady ? null : "mode_setup";
}
```

```ts
// src/app/generation/generationSessionOrchestrator.ts
const persona = await personaStore.get();
const rpProfile = sessionModeId === "rp_assistant" ? await rpProfileStore.get() : null;
const scenarioProfile = sessionModeId === "scenario_host" ? await scenarioProfileStore.get() : null;

const promptBuildResult = await services.promptBuilder.buildChatPromptMessages({
  // ...
  persona,
  rpProfile,
  scenarioProfile
});
```

- [ ] **Step 4: 重新跑 generation/toolset 测试**

Run: `node test/run-node-tests.mjs test/generation/toolset-selection-policy.test.tsx test/generation/generation-prompt-builder.test.tsx`
Expected: PASS，setup 选择逻辑改为 `personaReady -> modeProfileReady -> operationMode`。

- [ ] **Step 5: 提交模式判定重构**

```bash
git add \
  src/modes/types.ts \
  src/modes/rpAssistantMode.ts \
  src/modes/scenarioHost/mode.ts \
  src/app/generation/generationSetupContext.ts \
  src/app/generation/generationSessionOrchestrator.ts \
  src/app/bootstrap/bootstrapServices.ts \
  test/generation/toolset-selection-policy.test.tsx \
  test/generation/generation-prompt-builder.test.tsx
git commit -m "refactor: drive setup flow from readiness and operation mode"
```

## Task 4: 为 persona / rp / scenario 草稿建立专用工具，并在 normal 态移除写入口

**Files:**
- Modify: `src/llm/tools/profile/profileTools.ts`
- Modify: `src/llm/tools/toolsetCatalog.ts`
- Modify: `src/llm/tools/toolsetSelectionPolicy.ts`
- Modify: `src/llm/prompt/promptToolHints.ts`
- Modify: `test/tools/tool-runtime-features.test.tsx`

- [ ] **Step 1: 先写失败测试，约束 normal 态没有写工具，配置态只暴露对应 profile 工具**

```ts
test("normal mode hides persona and mode profile write tools", async () => {
  const names = listToolNames(buildToolRuntime({ operationMode: { kind: "normal" }, relationship: "owner" }));
  assert.equal(names.includes("patch_persona"), false);
  assert.equal(names.includes("patch_rp_profile"), false);
  assert.equal(names.includes("patch_scenario_profile"), false);
});

test("persona_config only exposes persona draft tools", async () => {
  const names = listToolNames(buildToolRuntime({ operationMode: { kind: "persona_config", draft: createEmptyPersona() }, relationship: "owner" }));
  assert.deepEqual(
    names.filter((name) => name.includes("persona") || name.includes("profile")),
    ["get_persona", "patch_persona", "clear_persona_field"]
  );
});
```

- [ ] **Step 2: 跑工具测试，确认旧工具仍在 normal 态可写**

Run: `node test/run-node-tests.mjs test/tools/tool-runtime-features.test.tsx`
Expected: FAIL，owner 默认仍看到 `patch_persona`。

- [ ] **Step 3: 增加 rp/scenario draft 工具并按 operationMode 裁剪**

```ts
// src/llm/tools/profile/profileTools.ts
{
  ownerOnly: true,
  definition: {
    type: "function",
    function: {
      name: "patch_rp_profile",
      description: "修改当前会话中的 rpProfile 草稿，不直接写持久化存储。",
      parameters: {
        type: "object",
        properties: {
          profilePatch: {
            type: "object",
            properties: {
              appearance: { type: "string" },
              premise: { type: "string" },
              relationship: { type: "string" },
              identityBoundary: { type: "string" },
              styleRules: { type: "string" },
              hardRules: { type: "string" }
            },
            additionalProperties: false
          }
        },
        required: ["profilePatch"],
        additionalProperties: false
      }
    }
  }
}
```

```ts
// src/llm/tools/toolsetSelectionPolicy.ts
if (input.operationMode?.kind === "normal") {
  visibleToolNames.delete("patch_persona");
  visibleToolNames.delete("clear_persona_field");
  visibleToolNames.delete("patch_rp_profile");
  visibleToolNames.delete("clear_rp_profile_field");
  visibleToolNames.delete("patch_scenario_profile");
  visibleToolNames.delete("clear_scenario_profile_field");
}
```

- [ ] **Step 4: 重新跑工具测试**

Run: `node test/run-node-tests.mjs test/tools/tool-runtime-features.test.tsx`
Expected: PASS，normal 态无写工具，配置态只暴露对应草稿工具。

- [ ] **Step 5: 提交工具层改动**

```bash
git add \
  src/llm/tools/profile/profileTools.ts \
  src/llm/tools/toolsetCatalog.ts \
  src/llm/tools/toolsetSelectionPolicy.ts \
  src/llm/prompt/promptToolHints.ts \
  test/tools/tool-runtime-features.test.tsx
git commit -m "feat: scope profile tools to configuration drafts"
```

## Task 5: 重写 `.setup` / `.config` / `.confirm` / `.cancel` 命令与自动进入流程

**Files:**
- Modify: `src/app/messaging/directCommands.ts`
- Modify: `src/app/messaging/messageEventHandler.ts`
- Modify: `src/app/messaging/messageContextBuilder.ts`
- Modify: `src/app/messaging/messageHandlerTypes.ts`
- Modify: `src/app/messaging/messageAdmission.ts`
- Modify: `src/app/messaging/messageSetupFlow.ts`
- Modify: `src/app/bootstrap/appSetupSupport.ts`
- Modify: `test/messaging/direct-command-features.test.tsx`

- [ ] **Step 1: 先写失败测试，锁定 setup/config 草稿语义和确认后清空历史**

```ts
test(".setup rp enters mode_setup with empty draft", async () => {
  const state = createHarnessSession({ modeId: "rp_assistant", operationMode: { kind: "normal" } });
  await runDirectCommand(".setup rp", { relationship: "owner", session: state });
  assert.deepEqual(state.operationMode, {
    kind: "mode_setup",
    modeId: "rp_assistant",
    draft: createEmptyRpProfile()
  });
});

test(".config persona clones saved persona into draft", async () => {
  personaStore.write({ name: "Mina", coreIdentity: "创作者", personality: "冷静", interests: "", background: "", speechStyle: "短句" });
  await runDirectCommand(".config persona", { relationship: "owner" });
  assert.equal(session.operationMode.kind, "persona_config");
  assert.equal(session.operationMode.draft.name, "Mina");
});

test(".confirm persists draft and clears session", async () => {
  await runDirectCommand(".confirm", { relationship: "owner", session });
  assert.equal(clearSessionCalls.length, 1);
  assert.match(lastReplyText, /当前会话历史已清空/);
});

test("pre-router owner bootstrap is checked independently from profile readiness", async () => {
  const decision = resolvePreRouterSetupDecision({
    ownerBound: false,
    personaReady: false,
    channelId: "qqbot",
    eventMessageType: "private",
    eventUserId: "10001",
    selfId: "99999",
    rawText: "你好",
    segmentCount: 1
  });
  assert.equal(decision.kind, "reject_private_before_owner_bound");
});
```

- [ ] **Step 2: 跑 direct command 测试，确认旧命令集不支持 setup/config 草稿**

Run: `node test/run-node-tests.mjs test/messaging/direct-command-features.test.tsx`
Expected: FAIL，`.setup rp` / `.config scenario` / 草稿确认语义尚不存在。

- [ ] **Step 3: 重构 direct commands 与自动进入逻辑**

```ts
// src/app/messaging/directCommands.ts
type DirectCommandArgsMap = {
  setup: { target: "persona" | "rp" | "scenario" };
  config: { target: "persona" | "rp" | "scenario" };
  confirm: {};
  cancel: {};
  // 保留其他命令...
};

function enterPersonaSetupDraft(ctx: DirectCommandExecutionContext) {
  ctx.input.sessionManager.setOperationMode(ctx.session.id, {
    kind: "persona_setup",
    draft: createEmptyPersona()
  });
}

async function confirmConfigurationDraft(ctx: DirectCommandExecutionContext) {
  const operationMode = ctx.input.sessionManager.getOperationMode(ctx.session.id);
  if (operationMode.kind === "persona_setup" || operationMode.kind === "persona_config") {
    await ctx.input.personaStore.write(operationMode.draft);
    await ctx.input.globalProfileReadinessStore.syncPersona(operationMode.draft);
  }
  ctx.input.sessionManager.setOperationMode(ctx.session.id, { kind: "normal" });
  ctx.input.sessionManager.clearSession(ctx.session.id);
  await ctx.send("配置已确认，当前会话历史已清空。");
}
```

```ts
// src/app/messaging/messageSetupFlow.ts
if (modeId === "rp_assistant" && personaReady && !rpReady) {
  sessionManager.setOperationMode(sessionId, {
    kind: "mode_setup",
    modeId: "rp_assistant",
    draft: createEmptyRpProfile()
  });
}
```

```ts
// src/app/messaging/messageAdmission.ts
export function resolvePreRouterSetupDecision(input: {
  ownerBound: boolean;
  personaReady: boolean;
  channelId: string;
  eventMessageType: "private" | "group";
  eventUserId: string;
  selfId: string;
  rawText: string;
  segmentCount: number;
}): PreRouterSetupDecision {
  if (!input.ownerBound && input.eventMessageType === "private" && input.eventUserId !== input.selfId) {
    return {
      kind: "reject_private_before_owner_bound",
      userId: input.eventUserId,
      text: "当前实例还没有完成管理者绑定。请先发送 `.own` 完成认领。"
    };
  }
  return { kind: "allow" };
}
```

- [ ] **Step 4: 重新跑 direct command 测试**

Run: `node test/run-node-tests.mjs test/messaging/direct-command-features.test.tsx`
Expected: PASS，`.setup/.config/.confirm/.cancel` 与“清空历史”返回文案都符合设计。

- [ ] **Step 5: 提交命令与自动进入流程**

```bash
git add \
  src/app/messaging/directCommands.ts \
  src/app/messaging/messageEventHandler.ts \
  src/app/messaging/messageContextBuilder.ts \
  src/app/messaging/messageHandlerTypes.ts \
  src/app/messaging/messageAdmission.ts \
  src/app/messaging/messageSetupFlow.ts \
  src/app/bootstrap/appSetupSupport.ts \
  test/messaging/direct-command-features.test.tsx
git commit -m "feat: add setup and config command workflows"
```

## Task 6: 按 operationMode 拆分 setup/config prompt 与 draft 读取

**Files:**
- Modify: `src/llm/prompts/chat-system.prompt.ts`
- Modify: `src/app/generation/generationSessionOrchestrator.ts`
- Modify: `src/app/generation/generationPromptBuilder.ts`
- Modify: `test/generation/generation-prompt-builder.test.tsx`
- Modify: `test/prompt/prompt-persona-features.test.tsx`

- [ ] **Step 1: 先写失败测试，约束 setup 与 config prompt 分离**

```ts
test("persona setup prompt describes empty draft initialization", async () => {
  const system = await buildSystemPrompt({ operationMode: { kind: "persona_setup", draft: createEmptyPersona() } });
  assert.match(system, /从空白草稿开始补齐 persona/);
  assert.doesNotMatch(system, /基于当前已保存 persona/);
});

test("persona config prompt describes editing saved draft copy", async () => {
  const system = await buildSystemPrompt({ operationMode: { kind: "persona_config", draft: savedPersona } });
  assert.match(system, /先读取当前 persona/);
  assert.match(system, /修改的是草稿/);
});
```

- [ ] **Step 2: 跑 prompt 测试，确认旧 prompt 只区分 setup / non-setup**

Run: `node test/run-node-tests.mjs test/generation/generation-prompt-builder.test.tsx test/prompt/prompt-persona-features.test.tsx`
Expected: FAIL，旧 prompt 没有 `config` 专用语义，也没有草稿说明。

- [ ] **Step 3: 按 operationMode 选择 prompt 模板，并从草稿取 profile**

```ts
// src/app/generation/generationSessionOrchestrator.ts
const operationMode = refreshedSession.operationMode;
const promptBuildResult = operationMode.kind === "persona_setup"
  ? await services.promptBuilder.buildPersonaSetupPromptMessages({ draft: operationMode.draft, ...sharedInput })
  : operationMode.kind === "persona_config"
    ? await services.promptBuilder.buildPersonaConfigPromptMessages({ draft: operationMode.draft, ...sharedInput })
    : operationMode.kind === "mode_setup"
      ? await services.promptBuilder.buildModeSetupPromptMessages({ modeId: operationMode.modeId, draft: operationMode.draft, ...sharedInput })
      : operationMode.kind === "mode_config"
        ? await services.promptBuilder.buildModeConfigPromptMessages({ modeId: operationMode.modeId, draft: operationMode.draft, ...sharedInput })
        : await services.promptBuilder.buildChatPromptMessages(sharedInput);
```

```ts
// src/llm/prompts/chat-system.prompt.ts
export function buildPersonaConfigSystemLines(input: { draft: Persona }): string[] {
  return [
    "当前处于 persona 配置模式。",
    "先读取当前 persona 草稿，只根据 owner 明确要求修改字段。",
    "你修改的是临时草稿；只有 owner 输入 .confirm 才会真正保存。",
    "如果 owner 输入 .cancel，则所有本轮改动都会丢弃。"
  ];
}
```

- [ ] **Step 4: 重新跑 prompt 测试**

Run: `node test/run-node-tests.mjs test/generation/generation-prompt-builder.test.tsx test/prompt/prompt-persona-features.test.tsx`
Expected: PASS，setup/config 各自有独立 prompt，且明确草稿语义。

- [ ] **Step 5: 提交 prompt 分层改动**

```bash
git add \
  src/llm/prompts/chat-system.prompt.ts \
  src/app/generation/generationSessionOrchestrator.ts \
  src/app/generation/generationPromptBuilder.ts \
  test/generation/generation-prompt-builder.test.tsx \
  test/prompt/prompt-persona-features.test.tsx
git commit -m "feat: split setup and config prompts by operation mode"
```

## Task 7: 更新内部 API / 编辑器 / WebUI 展示语义

**Files:**
- Modify: `src/internalApi/application/editorService.ts`
- Modify: `src/internalApi/application/webSessionStream.ts`
- Modify: `src/internalApi/types.ts`
- Modify: `webui/src/stores/sessions.ts`
- Modify: `webui/src/stores/sessionDisplay.ts`
- Modify: `webui/src/composables/sections/useSessionsSection.ts`
- Modify: `test/webui/session-display.test.ts`
- Modify: `test/internalApi/features.test.tsx`

- [ ] **Step 1: 先写失败测试，约束编辑器资源和 session 展示字段**

```ts
test("editor service exposes persona rp_profile scenario_profile and global_profile_readiness", async () => {
  const { resources } = await createEditorService(deps).listResources();
  const keys = resources.map((item) => item.key);
  assert.ok(keys.includes("persona"));
  assert.ok(keys.includes("rp_profile"));
  assert.ok(keys.includes("scenario_profile"));
  assert.ok(keys.includes("global_profile_readiness"));
  assert.equal(keys.includes("setup_state"), false);
});

test("session display renders operation mode label", () => {
  const item = normalizeSessionListItem({
    id: "qqbot:p:test",
    modeId: "rp_assistant",
    operationMode: { kind: "mode_config", modeId: "rp_assistant" }
  });
  assert.equal(item.operationModeLabel, "配置 RP 设定");
});
```

- [ ] **Step 2: 跑 WebUI / internal API 测试，确认旧接口仍暴露 setup_state**

Run: `node test/run-node-tests.mjs test/webui/session-display.test.ts test/internalApi/features.test.tsx`
Expected: FAIL，资源列表与 session stream 尚未反映新 operationMode/readiness。

- [ ] **Step 3: 调整 editor resources、session stream payload 和前端展示**

```ts
// src/internalApi/application/editorService.ts
single("persona", "全局 Persona", "data", personaSchema, `${dataDir}/persona.json`),
single("rp_profile", "RP Profile", "data", rpProfileSchema, `${dataDir}/rp-profile.json`),
single("scenario_profile", "Scenario Profile", "data", scenarioProfileSchema, `${dataDir}/scenario-profile.json`),
single("global_profile_readiness", "全局 Profile Readiness", "data", globalProfileReadinessSchema, `${dataDir}/global-profile-readiness.json`),
```

```ts
// src/internalApi/application/webSessionStream.ts
return {
  id: snapshot.id,
  modeId: snapshot.modeId,
  operationMode: snapshot.operationMode,
  // ...
};
```

```ts
// webui/src/stores/sessionDisplay.ts
export function resolveOperationModeLabel(operationMode: SessionOperationMode): string {
  switch (operationMode.kind) {
    case "persona_setup": return "初始化 Persona";
    case "mode_setup": return operationMode.modeId === "rp_assistant" ? "初始化 RP 设定" : "初始化 Scenario 设定";
    case "persona_config": return "配置 Persona";
    case "mode_config": return operationMode.modeId === "rp_assistant" ? "配置 RP 设定" : "配置 Scenario 设定";
    default: return "正常运行";
  }
}
```

- [ ] **Step 4: 重新跑 WebUI / internal API 测试**

Run: `node test/run-node-tests.mjs test/webui/session-display.test.ts test/internalApi/features.test.tsx`
Expected: PASS，编辑器资源与 session 展示改为 persona/rp/scenario/readiness/operationMode 语义。

- [ ] **Step 5: 提交 API 与 WebUI 语义更新**

```bash
git add \
  src/internalApi/application/editorService.ts \
  src/internalApi/application/webSessionStream.ts \
  src/internalApi/types.ts \
  webui/src/stores/sessions.ts \
  webui/src/stores/sessionDisplay.ts \
  webui/src/composables/sections/useSessionsSection.ts \
  test/webui/session-display.test.ts \
  test/internalApi/features.test.tsx
git commit -m "feat: expose operation mode and profile resources"
```

## Task 8: 清理旧 setupState 语义、更新文档并做全量验证

**Files:**
- Modify: `src/identity/setupStateSchema.ts`
- Modify: `src/identity/setupStateStore.ts`
- Modify: `README.md`
- Modify: `config/global.example.yml`
- Modify: `test/messaging/direct-command-features.test.tsx`
- Modify: `test/generation/toolset-selection-policy.test.tsx`
- Modify: `test/tools/tool-runtime-features.test.tsx`
- Modify: `test/webui/session-display.test.ts`

- [ ] **Step 1: 先写或补充失败测试，确保旧 setupState 路径不再被引用**

```ts
test("no runtime component still depends on legacy setupState", async () => {
  const source = await readFile(new URL("../../src/app/generation/generationSetupContext.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setupState/);
  assert.match(source, /globalProfileReadinessStore/);
});
```

- [ ] **Step 2: 跑针对性测试与类型检查，确认还有旧命名残留**

Run: `node test/run-node-tests.mjs test/messaging/direct-command-features.test.tsx test/generation/toolset-selection-policy.test.tsx test/tools/tool-runtime-features.test.tsx test/webui/session-display.test.ts`
Expected: FAIL 或存在引用旧 `setupState` / `needs_persona` / `needs_owner` 的断言残留。

- [ ] **Step 3: 删除旧 setupState 残留并更新文档**

```ts
// src/app/generation/generationSetupContext.ts
const readiness = await deps.globalProfileReadinessStore.get();
return {
  personaReady: readiness.persona === "ready",
  modeProfileReady: modeId === "rp_assistant"
    ? readiness.rp === "ready"
    : modeId === "scenario_host"
      ? readiness.scenario === "ready"
      : true,
  operationMode: deps.sessionManager.getOperationMode(sessionId),
  chatType: chatContext.chatType,
  relationship: chatContext.relationship
};
```

```md
<!-- README.md -->
- `persona` 现仅表示全局人格与基础身份
- `rpProfile` 与 `scenarioProfile` 为模式专属全局资料
- `.setup` 基于空白草稿，`.config` 基于已保存配置副本草稿
- `.confirm` / `.cancel` 都会清空当前会话历史
```

- [ ] **Step 4: 跑最终验证**

Run: `npm run typecheck:all`
Expected: PASS

Run: `npm run test`
Expected: PASS

- [ ] **Step 5: 提交清理与文档更新**

```bash
git add \
  src \
  test \
  README.md \
  config/global.example.yml
git commit -m "refactor: replace legacy setup state with profile readiness"
```

## Self-Review

### Spec coverage

- 全局资料拆分：Task 1
- 会话工作态与草稿：Task 2
- persona 优先、模式 profile 次级依赖：Task 3
- normal 态禁写、配置态按对象裁剪工具：Task 4
- `.setup/.config/.confirm/.cancel` 与自动进入：Task 5
- owner bootstrap 从 readiness 中独立：Task 5
- setup/config prompt 分离：Task 6
- WebUI / editor / session 展示语义：Task 7
- 删除旧 setupState 语义与全量验证：Task 8

### Placeholder scan

- 无 `TBD` / `TODO` / “适当处理” 类占位语句
- 每个任务都给出具体文件、示例代码、执行命令和预期结果

### Type consistency

- readiness 命名统一为 `persona/rp/scenario`
- 会话工作态统一为 `SessionOperationMode`
- 模式 ID 统一使用 `rp_assistant` 与 `scenario_host`
- 草稿语义统一为“配置态工具只改 draft，`.confirm` 才持久化”

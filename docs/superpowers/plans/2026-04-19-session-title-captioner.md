# Session Title And Captioner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Web 会话引入独立 `session.title` / `titleSource` / `participantRef`，删除 `participantLabel` 与 `scenario_host.state.title`，并接入手动重命名与 `sessionCaptioner`。

**Architecture:** 先收敛 session 数据模型和 persistence/API 契约，再替换 WebUI 的会话展示与创建/重命名入口，最后引入 `sessionCaptioner` 及其触发时机。`session.title` 成为唯一标题真值，`participantRef` 只表达会话主体，scenario_host 标题提升到 session 层。

**Tech Stack:** Node.js 20、TypeScript、Zod、Vue 3、Pinia、Fastify、现有 test harness

---

## File Map

- Create: `src/conversation/session/sessionTitle.ts`
- Create: `src/app/generation/sessionCaptioner.ts`
- Modify: `src/conversation/session/sessionTypes.ts`
- Modify: `src/conversation/session/sessionStateFactory.ts`
- Modify: `src/conversation/session/sessionPersistence.ts`
- Modify: `src/conversation/session/sessionQueries.ts`
- Modify: `src/conversation/session/sessionCapabilities.ts`
- Modify: `src/conversation/session/sessionIdentity.ts`
- Modify: `src/modes/scenarioHost/types.ts`
- Modify: `src/modes/scenarioHost/stateStore.ts`
- Modify: `src/llm/tools/conversation/scenarioHostTools.ts`
- Modify: `src/internalApi/routeSupport.ts`
- Modify: `src/internalApi/routes/basicRoutes.ts`
- Modify: `src/internalApi/application/basicAdminService.ts`
- Modify: `src/internalApi/types.ts`
- Modify: `src/app/generation/generationSessionOrchestrator.ts`
- Modify: `src/app/generation/generationTurnPlanner.ts`
- Modify: `src/config/configModel.ts`
- Modify: `src/config/config.ts`
- Modify: `webui/src/api/types.ts`
- Modify: `webui/src/api/sessions.ts`
- Modify: `webui/src/stores/sessions.ts`
- Modify: `webui/src/components/sessions/CreateSessionDialog.vue`
- Modify: `webui/src/components/sessions/SessionListItem.vue`
- Modify: `webui/src/pages/SessionsPage.vue`
- Modify: `webui/src/components/sessions/ChatPanel.vue`
- Modify: `webui/src/components/sessions/SessionStatePanel.vue`
- Modify: `webui/src/components/sessions/ScenarioHostStateEditor.vue`
- Test: `test/session/persistence.test.tsx`
- Test: `test/session/session-identity.test.tsx`
- Test: `test/internalApi/features.test.tsx`
- Test: `test/internalApi/messaging-admin-service.test.tsx`
- Test: `test/tools/tool-runtime-features.test.tsx`
- Test: `test/modes/scenario-host-state-store.test.tsx`
- Test: `test/webui/sessions/chat-panel-source.test.tsx`
- Test: `test/webui/sessions/session-state-panel.test.tsx`
- Test: `test/webui/sessions/create-session-dialog.test.ts`

### Task 1: 收敛 Session 数据模型到 `title` / `titleSource` / `participantRef`

**Files:**
- Create: `src/conversation/session/sessionTitle.ts`
- Modify: `src/conversation/session/sessionTypes.ts`
- Modify: `src/conversation/session/sessionStateFactory.ts`
- Modify: `src/conversation/session/sessionPersistence.ts`
- Modify: `src/conversation/session/sessionQueries.ts`
- Modify: `src/conversation/session/sessionCapabilities.ts`
- Modify: `src/conversation/session/sessionIdentity.ts`
- Test: `test/session/persistence.test.tsx`
- Test: `test/session/session-identity.test.tsx`

- [ ] **Step 1: 写失败测试，要求 session 持久化与 identity helper 使用新字段**

```ts
await runCase("session persistence round-trips title titleSource and participantRef", async () => {
  const session = createSessionState({
    id: "web:test",
    type: "private",
    source: "web",
    participantRef: { kind: "user", id: "owner" },
    title: "New Chat",
    titleSource: "default"
  });

  const persisted = toPersistedSessionState(session);
  assert.deepEqual(persisted.participantRef, { kind: "user", id: "owner" });
  assert.equal(persisted.title, "New Chat");
  assert.equal(persisted.titleSource, "default");
  assert.ok(!("participantLabel" in persisted));
  assert.ok(!("participantUserId" in persisted));
});

await runCase("session display title prefers session.title for web sessions", async () => {
  assert.equal(resolveSessionDisplayTitle({
    id: "web:test",
    source: "web",
    title: "Investigate vite build",
    participantRef: { kind: "user", id: "owner" }
  }), "Investigate vite build");
});

await runCase("group sessions keep group participant refs", async () => {
  const session = createSessionState({
    id: "qqbot:g:20001",
    type: "group",
    source: "onebot",
    participantRef: { kind: "group", id: "20001" }
  });

  assert.deepEqual(session.participantRef, { kind: "group", id: "20001" });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/session/session-identity.test.tsx test/session/persistence.test.tsx`  
Expected: FAIL，原因是 `participantRef` / `titleSource` / `resolveSessionDisplayTitle` 尚不存在，旧快照仍包含 `participantLabel`

- [ ] **Step 3: 写最小实现**

```ts
export interface SessionParticipantRef {
  kind: "user" | "group";
  id: string;
}

export type SessionTitleSource = "default" | "auto" | "manual";

export interface SessionState {
  id: string;
  type: "private" | "group";
  source: SessionSource;
  modeId: string;
  setupConfirmed: boolean;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
  // ...
}

export function resolveDefaultSessionTitle(modeId: string): string {
  return modeId === "scenario_host" ? "New Scenario" : "New Chat";
}

export function resolveSessionDisplayTitle(input: Pick<SessionState, "source" | "title" | "type" | "participantRef" | "id">): string {
  if (input.source === "web" && input.title?.trim()) {
    return input.title.trim();
  }
  return input.participantRef.kind === "group"
    ? `群 ${input.participantRef.id}`
    : input.participantRef.id;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/session/session-identity.test.tsx test/session/persistence.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/conversation/session/sessionTitle.ts src/conversation/session/sessionTypes.ts src/conversation/session/sessionStateFactory.ts src/conversation/session/sessionPersistence.ts src/conversation/session/sessionQueries.ts src/conversation/session/sessionCapabilities.ts src/conversation/session/sessionIdentity.ts test/session/session-identity.test.tsx test/session/persistence.test.tsx
git commit -m "refactor: add session title and participant ref model"
```

### Task 2: 替换 Internal API 与 Web 会话创建契约

**Files:**
- Modify: `src/internalApi/routeSupport.ts`
- Modify: `src/internalApi/routes/basicRoutes.ts`
- Modify: `src/internalApi/application/basicAdminService.ts`
- Modify: `src/internalApi/types.ts`
- Modify: `webui/src/api/types.ts`
- Modify: `webui/src/api/sessions.ts`
- Modify: `webui/src/stores/sessions.ts`
- Test: `test/internalApi/features.test.tsx`

- [ ] **Step 1: 写失败测试，要求 create-session 与 session summary 使用 title/titleSource/participantRef**

```ts
await runCase("internal api creates web sessions with default title and participantRef", async () => {
  const app = await createInternalApiApp(createInternalApiDeps());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { modeId: "rp_assistant" }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().session.title, "New Chat");
    assert.equal(response.json().session.titleSource, "default");
    assert.deepEqual(response.json().session.participantRef, { kind: "user", id: "owner" });
    assert.ok(!("participantLabel" in response.json().session));
  } finally {
    await app.close();
  }
});

await runCase("create session accepts manual title and marks it manual", async () => {
  const app = await createInternalApiApp(createInternalApiDeps());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { modeId: "scenario_host", title: "Warehouse infiltration" }
    });

    assert.equal(response.json().session.title, "Warehouse infiltration");
    assert.equal(response.json().session.titleSource, "manual");
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/internalApi/features.test.tsx`  
Expected: FAIL，旧 API 仍返回 `participantLabel` / `participantUserId`，且 create-session 不接 `title`

- [ ] **Step 3: 写最小实现**

```ts
const createSessionBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  modeId: z.string().trim().min(1).optional()
});

export async function createWebSession(deps: InternalApiSessionWriteDeps, body: ParsedCreateSessionBody) {
  const sessionId = createWebSessionId();
  const modeId = body.modeId ?? getDefaultSessionModeId();
  const title = body.title?.trim() || resolveDefaultSessionTitle(modeId);
  const titleSource = body.title?.trim() ? "manual" : "default";
  const session = deps.sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: "web",
    participantRef: { kind: "user", id: "owner" },
    title,
    titleSource
  });
  // ...
}

function buildSessionSummary(session: SessionState) {
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    modeId: session.modeId,
    participantRef: session.participantRef,
    title: session.title,
    titleSource: session.titleSource,
    isGenerating: deps.sessionManager.hasActiveResponse(session.id),
    lastActiveAt: session.lastActiveAt
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/internalApi/features.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/internalApi/routeSupport.ts src/internalApi/routes/basicRoutes.ts src/internalApi/application/basicAdminService.ts src/internalApi/types.ts webui/src/api/types.ts webui/src/api/sessions.ts webui/src/stores/sessions.ts test/internalApi/features.test.tsx
git commit -m "refactor: expose session title and participant refs via api"
```

### Task 3: 收口 scenario_host，移除 `state.title`

**Files:**
- Modify: `src/modes/scenarioHost/types.ts`
- Modify: `src/modes/scenarioHost/stateStore.ts`
- Modify: `src/llm/tools/conversation/scenarioHostTools.ts`
- Modify: `webui/src/components/sessions/ScenarioHostStateEditor.vue`
- Test: `test/modes/scenario-host-state-store.test.tsx`
- Test: `test/tools/tool-runtime-features.test.tsx`
- Test: `test/internalApi/features.test.tsx`

- [ ] **Step 1: 写失败测试，要求 scenario state 不再包含 title，tool 不能更新 title**

```ts
await runCase("scenario_host state initializes without title field", async () => {
  const state = createInitialScenarioHostSessionState({
    playerUserId: "owner",
    playerDisplayName: "Owner"
  });

  assert.ok(!("title" in state));
  assert.equal(state.currentSituation, "场景尚未开始，请根据玩家接下来的行动开始主持。");
});

await runCase("update_scenario_state ignores removed title field", async () => {
  const result = await scenarioHostToolHandlers.update_scenario_state(
    {} as any,
    { title: "Should not persist", currentSituation: "玩家来到门前" },
    context
  );

  const parsed = JSON.parse(String(result));
  assert.ok(!("title" in parsed));
  assert.equal(parsed.currentSituation, "玩家来到门前");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/modes/scenario-host-state-store.test.tsx test/tools/tool-runtime-features.test.tsx test/internalApi/features.test.tsx`  
Expected: FAIL，schema / tool 仍要求并返回 `title`

- [ ] **Step 3: 写最小实现**

```ts
export const scenarioHostSessionStateSchema = s.object({
  version: s.literal(1),
  currentSituation: s.string().default("场景尚未开始。"),
  currentLocation: s.union([s.string(), s.literal(null)]).default(null),
  sceneSummary: s.string().default(""),
  player: scenarioHostPlayerSchema,
  inventory: s.array(scenarioHostInventoryItemSchema).default([]),
  objectives: s.array(scenarioHostObjectiveSchema).default([]),
  worldFacts: s.array(s.string()).default([]),
  flags: s.record(/* ... */).default({}),
  initialized: s.boolean().default(false),
  turnIndex: s.number().int().min(0).default(0)
}).strict();

const state = await context.scenarioHostStateStore.update(
  context.lastMessage.sessionId,
  (current) => ({
    ...current,
    ...(currentSituation ? { currentSituation } : {}),
    ...(sceneSummary ? { sceneSummary } : {})
  }),
  getScenarioDefaults(context)
);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/modes/scenario-host-state-store.test.tsx test/tools/tool-runtime-features.test.tsx test/internalApi/features.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/modes/scenarioHost/types.ts src/modes/scenarioHost/stateStore.ts src/llm/tools/conversation/scenarioHostTools.ts webui/src/components/sessions/ScenarioHostStateEditor.vue test/modes/scenario-host-state-store.test.tsx test/tools/tool-runtime-features.test.tsx test/internalApi/features.test.tsx
git commit -m "refactor: move scenario titles into session metadata"
```

### Task 4: 改造 WebUI 的创建、展示与会话 info popup

**Files:**
- Modify: `webui/src/components/sessions/CreateSessionDialog.vue`
- Modify: `webui/src/components/sessions/SessionListItem.vue`
- Modify: `webui/src/pages/SessionsPage.vue`
- Modify: `webui/src/components/sessions/ChatPanel.vue`
- Modify: `webui/src/components/sessions/SessionStatePanel.vue`
- Modify: `webui/src/stores/sessions.ts`
- Modify: `webui/src/api/sessions.ts`
- Test: `test/webui/sessions/chat-panel-source.test.tsx`
- Test: `test/webui/sessions/session-state-panel.test.tsx`
- Test: `test/webui/sessions/create-session-dialog.test.ts`

- [ ] **Step 1: 写失败测试，要求弹窗使用 placeholder 作为默认标题并记住上次 mode**

```ts
await runCase("create session dialog uses title placeholder instead of prefilled value", async () => {
  const source = await readFile(new URL("../../../webui/src/components/sessions/CreateSessionDialog.vue", import.meta.url), "utf8");

  assert.match(source, /placeholder=.*New Chat/);
  assert.doesNotMatch(source, /v-model="title".*value="New Chat"/s);
});

await runCase("sessions page stores the last selected mode in localStorage", async () => {
  const source = await readFile(new URL("../../../webui/src/pages/SessionsPage.vue", import.meta.url), "utf8");

  assert.match(source, /localStorage/);
  assert.match(source, /lastSessionMode/);
});

await runCase("session info popup exposes rename and regenerate title controls for web sessions", async () => {
  const source = await readFile(new URL("../../../webui/src/pages/SessionsPage.vue", import.meta.url), "utf8");

  assert.match(source, /保存标题/);
  assert.match(source, /重新生成标题/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/webui/sessions/chat-panel-source.test.tsx test/webui/sessions/session-state-panel.test.tsx test/webui/sessions/create-session-dialog.test.ts`  
Expected: FAIL，旧弹窗仍使用 participantLabel 语义，且 popup 没有标题相关控件

- [ ] **Step 3: 写最小实现**

```vue
<script setup lang="ts">
const STORAGE_KEY = "lastSessionMode";
const modeId = ref(readStoredMode(props.modes));
const title = ref("");
const titlePlaceholder = computed(() => modeId.value === "scenario_host" ? "New Scenario" : "New Chat");

function submit() {
  emit("submit", {
    ...(title.value.trim() ? { title: title.value.trim() } : {}),
    modeId: modeId.value
  });
}
</script>

<template>
  <label>
    标题
    <input v-model="title" :placeholder="titlePlaceholder" class="input-base text-ui" />
  </label>
</template>
```

```ts
const displayedTitle = computed(() => store.active?.title ?? store.active?.id ?? "");

async function renameSessionTitle(sessionId: string, title: string) {
  const result = await sessionsApi.renameTitle(sessionId, { title });
  applyReturnedSessionSummary(result.session);
}

async function regenerateSessionTitle(sessionId: string) {
  const result = await sessionsApi.regenerateTitle(sessionId);
  applyReturnedSessionSummary(result.session);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/webui/sessions/chat-panel-source.test.tsx test/webui/sessions/session-state-panel.test.tsx test/webui/sessions/create-session-dialog.test.ts`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webui/src/components/sessions/CreateSessionDialog.vue webui/src/components/sessions/SessionListItem.vue webui/src/pages/SessionsPage.vue webui/src/components/sessions/ChatPanel.vue webui/src/components/sessions/SessionStatePanel.vue webui/src/stores/sessions.ts webui/src/api/sessions.ts test/webui/sessions/chat-panel-source.test.tsx test/webui/sessions/session-state-panel.test.tsx test/webui/sessions/create-session-dialog.test.ts
git commit -m "feat: add web session title editing controls"
```

### Task 5: 引入 `sessionCaptioner` 与标题生成接口

**Files:**
- Create: `src/app/generation/sessionCaptioner.ts`
- Modify: `src/config/configModel.ts`
- Modify: `src/config/config.ts`
- Modify: `src/internalApi/routeSupport.ts`
- Modify: `src/internalApi/routes/basicRoutes.ts`
- Modify: `src/internalApi/application/basicAdminService.ts`
- Modify: `src/internalApi/types.ts`
- Test: `test/internalApi/features.test.tsx`

- [ ] **Step 1: 写失败测试，要求 regenerate title API 只对 web 会话生效**

```ts
await runCase("internal api regenerates titles for web sessions", async () => {
  const deps = createInternalApiDeps();
  deps.sessionCaptioner = {
    async generateTitle() {
      return "Vite build investigation";
    }
  } as any;
  const app = await createInternalApiApp(deps);
  try {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { modeId: "assistant" }
    });
    const sessionId = createResponse.json().session.id;
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${encodeURIComponent(sessionId)}/title/regenerate`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().session.title, "Vite build investigation");
    assert.equal(response.json().session.titleSource, "auto");
  } finally {
    await app.close();
  }
});

await runCase("internal api rejects title regeneration for onebot sessions", async () => {
  const app = await createInternalApiApp(createInternalApiDeps());
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${encodeURIComponent("qqbot:p:10001")}/title/regenerate`
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /web/i);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/internalApi/features.test.tsx`  
Expected: FAIL，`sessionCaptioner` / regenerate route 尚不存在

- [ ] **Step 3: 写最小实现**

```ts
export interface SessionCaptioner {
  generateTitle(input: {
    sessionId: string;
    modeId: string;
    transcript: InternalTranscriptItem[];
    historySummary: string | null;
  }): Promise<string | null>;
}

export async function regenerateSessionTitle(deps: InternalApiSessionWriteDeps & {
  sessionCaptioner: SessionCaptioner;
}, sessionId: string) {
  const session = deps.sessionManager.getSession(sessionId);
  if (session.source !== "web") {
    throw new Error("Only web sessions support title regeneration");
  }
  const generated = await deps.sessionCaptioner.generateTitle({
    sessionId,
    modeId: session.modeId,
    transcript: session.internalTranscript,
    historySummary: session.historySummary
  });
  if (generated?.trim()) {
    session.title = generated.trim();
    session.titleSource = "auto";
    await deps.sessionPersistence.save(deps.sessionManager.getPersistedSession(sessionId));
  }
  return { ok: true as const, session: buildSessionSummary(session) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/internalApi/features.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/generation/sessionCaptioner.ts src/config/configModel.ts src/config/config.ts src/internalApi/routeSupport.ts src/internalApi/routes/basicRoutes.ts src/internalApi/application/basicAdminService.ts src/internalApi/types.ts test/internalApi/features.test.tsx
git commit -m "feat: add session title regeneration api"
```

### Task 6: 把 `sessionCaptioner` 接到首次命名、topic switch 和 scenario setup

**Files:**
- Modify: `src/app/generation/generationSessionOrchestrator.ts`
- Modify: `src/app/generation/generationTurnPlanner.ts`
- Modify: `src/internalApi/application/basicAdminService.ts`
- Modify: `src/modes/scenarioHost/stateStore.ts`
- Test: `test/generation/reply-gate.test.tsx`
- Test: `test/internalApi/features.test.tsx`
- Test: `test/tools/tool-runtime-features.test.tsx`

- [ ] **Step 1: 写失败测试，要求自动命名尊重 `titleSource` 与触发时机**

```ts
await runCase("topic switch after compression triggers session captioner for web sessions", async () => {
  const generatedTitles: string[] = [];
  const result = await runPlannerTurn({
    session: {
      id: "web:test",
      source: "web",
      modeId: "assistant",
      title: "New Chat",
      titleSource: "default"
    },
    plannerResult: { replyDecision: "reply_large", topicDecision: "new_topic", reason: "明显换题", toolsetIds: [] },
    sessionCaptioner: {
      async generateTitle() {
        generatedTitles.push("Planning database schema");
        return "Planning database schema";
      }
    }
  });

  assert.equal(result.finalAction, "topic_switch");
  assert.deepEqual(generatedTitles, ["Planning database schema"]);
});

await runCase("manual session titles are not auto-overridden", async () => {
  const generatedTitles: string[] = [];
  await runPlannerTurn({
    session: {
      id: "web:test",
      source: "web",
      modeId: "assistant",
      title: "Pinned name",
      titleSource: "manual"
    },
    plannerResult: { replyDecision: "reply_large", topicDecision: "new_topic", reason: "明显换题", toolsetIds: [] },
    sessionCaptioner: {
      async generateTitle() {
        generatedTitles.push("Should not run");
        return "Should not run";
      }
    }
  });

  assert.deepEqual(generatedTitles, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/generation/reply-gate.test.tsx test/internalApi/features.test.tsx test/tools/tool-runtime-features.test.tsx`  
Expected: FAIL，自动标题链路尚未接入 generation / setup

- [ ] **Step 3: 写最小实现**

```ts
async function maybeAutoCaptionSessionTitle(input: {
  session: SessionState;
  sessionCaptioner?: SessionCaptioner;
  persistSession?: (sessionId: string, reason: string) => Promise<void> | void;
}) {
  if (!input.sessionCaptioner) return;
  if (input.session.source !== "web") return;
  if (input.session.titleSource === "manual") return;
  const generated = await input.sessionCaptioner.generateTitle({
    sessionId: input.session.id,
    modeId: input.session.modeId,
    transcript: input.session.internalTranscript,
    historySummary: input.session.historySummary
  });
  if (!generated?.trim()) return;
  input.session.title = generated.trim();
  input.session.titleSource = "auto";
  await input.persistSession?.(input.session.id, "session_title_captioned");
}

if (planner.topicDecision === "new_topic" && planner.replyDecision !== "wait") {
  const compressed = await historyCompressor.compactOldHistoryKeepingRecent(input.sessionId, preservedMessageCount);
  if (compressed) {
    await maybeAutoCaptionSessionTitle({
      session: sessionManager.getSession(input.sessionId),
      sessionCaptioner: input.sessionCaptioner,
      persistSession
    });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/generation/reply-gate.test.tsx test/internalApi/features.test.tsx test/tools/tool-runtime-features.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/generation/generationSessionOrchestrator.ts src/app/generation/generationTurnPlanner.ts src/internalApi/application/basicAdminService.ts src/modes/scenarioHost/stateStore.ts test/generation/reply-gate.test.tsx test/internalApi/features.test.tsx test/tools/tool-runtime-features.test.tsx
git commit -m "feat: trigger session captioning from topic switches and setup"
```

### Task 7: 全量校验、文档同步与清理旧字段

**Files:**
- Modify: `README.md`
- Modify: `config/global.example.yml`
- Modify: 受 `participantLabel` / `participantUserId` 影响但尚未改到的剩余测试

- [ ] **Step 1: 搜索并清理旧字段残留**

```bash
rg -n "participantLabel|participantUserId|state\\.title" src webui test README.md config
```

Expected: 仅剩允许保留的兼容文本；若还有运行时代码命中，继续清理直到没有旧语义字段

- [ ] **Step 2: 补 README 和配置示例**

```yml
sessionCaptioner:
  enabled: true
  modelRef: qwen_small
  maxInputMessages: 8
  maxTitleLength: 48
  stylePrompt: |
    为当前 Web 会话生成简短、描述性、非小说风格的标题。
```

```md
- Web 会话支持独立 `session.title`
- 手动重命名后不再被自动标题覆盖
- 仅 Web 会话支持自动标题与重新生成标题
```

- [ ] **Step 3: 跑全量校验**

Run: `npm run typecheck:all`  
Expected: PASS

Run: `npm test`  
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add README.md config/global.example.yml src webui test
git commit -m "chore: finalize session title captioner rollout"
```

## Self-Review

- **Spec coverage:**  
  - `session.title` / `titleSource` / `participantRef`：Task 1-2  
  - 删除 `participantLabel` / `scenario_host.state.title`：Task 1、3、7  
  - 新建会话 placeholder + last mode：Task 4  
  - 手动 rename 与 regenerate：Task 4-5  
  - `sessionCaptioner` 配置与触发：Task 5-6  
  - 非 Web 会话不自动生成标题：Task 2、5、6

- **Placeholder scan:**  
  - 未使用 `TODO` / `TBD` / “类似 Task N”  
  - 每个任务都包含具体测试、运行命令、实现骨架与提交命令

- **Type consistency:**  
  - 统一使用 `participantRef`
  - 统一使用 `title` / `titleSource`
  - regenerate API 统一命名为 `/title/regenerate`


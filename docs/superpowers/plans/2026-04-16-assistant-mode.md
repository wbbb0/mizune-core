# Assistant Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一个与 `rp_assistant` 隔离的普通 `assistant` 会话模式，只保留本会话功能工具，不读取 persona、长期记忆、用户档案、全局规则或跨会话能力。

**Architecture:** 在 `src/modes/` 新增 `assistant` mode definition，并把聊天 prompt 构建拆成显式的 mode strategy 分支。`assistant` strategy 只使用消息事实层上下文和功能工具提示，不触发 setup，也不访问 persona/记忆/规则相关存储。`rp_assistant` 和 `scenario_host` 继续走各自策略，避免后续 RP 改动误伤普通 assistant。

**Tech Stack:** Node.js, TypeScript, Fastify internal API, Vue 3 + Pinia WebUI, existing prompt/toolset/session architecture

---

### Task 1: 注册新模式并锁定工具边界

**Files:**
- Create: `src/modes/assistantMode.ts`
- Modify: `src/modes/registry.ts`
- Modify: `test/generation/toolset-selection-policy.test.tsx`
- Modify: `test/tools/tool-runtime-features.test.tsx`
- Modify: `test/internalApi/features.test.tsx`

- [ ] **Step 1: 写一个失败测试，证明 assistant mode 只暴露约定工具集**

```ts
await runCase("assistant mode defaults to local functional toolsets only", async () => {
  const config = createTestAppConfig({
    browser: { enabled: true, playwright: { enabled: true } },
    shell: { enabled: true }
  });
  const toolsets = listTurnToolsets({
    config,
    relationship: "owner",
    currentUser: null,
    modelRef: ["main"],
    includeDebugTools: false,
    modeId: "assistant"
  });

  assert.deepEqual(toolsets.map((item) => item.id), [
    "chat_context",
    "web_research",
    "shell_runtime",
    "local_file_io",
    "chat_file_io",
    "scheduler_admin",
    "comfy_image",
    "time_utils"
  ]);
});
```

- [ ] **Step 2: 运行测试确认它因为模式不存在而失败**

Run: `node test/generation/toolset-selection-policy.test.tsx`  
Expected: FAIL，报 `Unsupported session mode: assistant` 或缺少 assistant mode 相关断言失败

- [ ] **Step 3: 最小实现 assistant mode definition 并注册**

```ts
export const assistantModeDefinition: SessionModeDefinition = {
  id: "assistant",
  title: "Assistant",
  description: "普通助手模式。不读取 persona、记忆或用户资料，仅保留本会话功能工具。",
  allowedChatTypes: ["private", "group"],
  defaultToolsetIds: [
    "chat_context",
    "web_research",
    "shell_runtime",
    "local_file_io",
    "chat_file_io",
    "scheduler_admin",
    "comfy_image",
    "time_utils"
  ]
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/generation/toolset-selection-policy.test.tsx`  
Expected: PASS，assistant mode 工具集顺序和内容匹配

- [ ] **Step 5: 补模式列表与切换测试**

```ts
assert.deepEqual(modesResponse.json().modes, [{
  id: "rp_assistant",
  title: "RP Assistant",
  description: "当前默认模式。保留现有角色扮演 + 助手能力。",
  allowedChatTypes: ["private", "group"]
}, {
  id: "assistant",
  title: "Assistant",
  description: "普通助手模式。不读取 persona、记忆或用户资料，仅保留本会话功能工具。",
  allowedChatTypes: ["private", "group"]
}, {
  id: "scenario_host",
  title: "Scenario Host",
  description: "轻规则单人剧情主持模式。当前仅支持私聊。",
  allowedChatTypes: ["private"]
}]);
```

- [ ] **Step 6: 运行 API 与工具测试确认通过**

Run: `node test/tools/tool-runtime-features.test.tsx && node test/internalApi/features.test.tsx`  
Expected: PASS，模式列表包含 `assistant`，且能像其他 mode 一样被切换

### Task 2: 拆出 mode-specific prompt strategy，并先让 assistant prompt 红灯

**Files:**
- Modify: `src/llm/prompts/chat-system.prompt.ts`
- Modify: `src/llm/prompt/promptBuilder.ts`
- Modify: `test/generation/generation-prompt-builder.test.tsx`
- Modify: `test/prompt/prompt-rendering-features.test.tsx`

- [ ] **Step 1: 写失败测试，证明 assistant prompt 不含 RP/记忆段但保留消息头**

```ts
await runCase("assistant prompt keeps message headers but excludes rp and memory sections", async () => {
  const prompt = buildPrompt({
    sessionId: "group:123456",
    modeId: "assistant",
    persona: { name: "Bot", role: "角色", personality: "冷静", speechStyle: "简洁" } as any,
    relationship: "known",
    npcProfiles: [{ userId: "npc_1", displayName: "Npc" }],
    participantProfiles: [{ userId: "10001", displayName: "Alice", relationshipLabel: "熟人" }],
    userProfile: createPromptUserProfile({ userId: "10002", senderName: "Bob", relationship: "known" }),
    currentUserMemories: [{ id: "m1", kind: "preference", title: "偏好", content: "不吃香菜", createdAt: 1, updatedAt: 1 }],
    globalRules: [{ id: "g1", title: "规则", content: "先结论", source: "owner_explicit", createdAt: 1, updatedAt: 1 }],
    historySummary: "summary",
    recentMessages: [],
    batchMessages: [
      createPromptBatchMessage({ userId: "10002", senderName: "Bob", text: "帮我查一下", timestampMs: Date.UTC(2026, 2, 16, 9, 13, 10) })
    ]
  });

  const system = String(prompt[0]?.content ?? "");
  const batchText = readPromptMessageText(prompt[1]);
  assert.doesNotMatch(system, /⟦section name="persona"⟧/);
  assert.doesNotMatch(system, /⟦section name="memory_write_decision"⟧/);
  assert.doesNotMatch(system, /⟦section name="global_rules"⟧/);
  assert.doesNotMatch(system, /⟦section name="current_user_profile"⟧/);
  assert.doesNotMatch(system, /⟦section name="current_user_memories"⟧/);
  assert.match(batchText, /⟦trigger_batch session="群聊 123456"/);
  assert.match(batchText, /⟦trigger_message index="1" speaker="Bob \(10002\)"/);
});
```

- [ ] **Step 2: 运行测试确认当前实现会失败**

Run: `node test/prompt/prompt-rendering-features.test.tsx && node test/generation/generation-prompt-builder.test.tsx`  
Expected: FAIL，当前 `assistant` 仍走默认 RP prompt 分支

- [ ] **Step 3: 实现 assistant strategy 的最小系统段生成**

```ts
if (input.modeId === "assistant") {
  return [
    renderPromptSection("assistant_identity", [
      "你是普通中文 assistant，优先直接理解并完成用户请求。",
      "不要把自己当成角色扮演人物，也不要编造 persona、关系或背景设定。"
    ]),
    renderPromptSection("disclosure", buildDisclosureLines(input.interactionMode)),
    renderPromptSection("reply_rules", buildReplyRuleLines()),
    renderPromptSection("context_rules", buildContextRuleLines({ visibleToolNames: input.visibleToolNames })),
    renderPromptSection("toolset_guidance", buildToolsetGuidanceLines({
      activeToolsets: input.activeToolsets,
      visibleToolNames: input.visibleToolNames
    })),
    renderPromptSection("live_resources", buildLiveResourceLines(input.liveResources)),
    renderPromptSection("history_summary", buildHistorySummaryLines(input.historySummary)),
    renderPromptSection("recent_tool_events", buildRecentToolEventLines(input.recentToolEvents))
  ].filter((item): item is string => Boolean(item));
}
```

- [ ] **Step 4: 运行 prompt 测试确认通过**

Run: `node test/prompt/prompt-rendering-features.test.tsx && node test/generation/generation-prompt-builder.test.tsx`  
Expected: PASS，assistant prompt 只保留普通 assistant 段和消息事实层结构

### Task 3: 裁掉 assistant mode 的资料类数据读取

**Files:**
- Modify: `src/app/generation/generationPromptBuilder.ts`
- Modify: `src/app/generation/generationSessionOrchestrator.ts`
- Modify: `test/generation/generation-prompt-builder.test.tsx`

- [ ] **Step 1: 写失败测试，证明 assistant mode 不应读取规则与 scenario/persona 相关存储**

```ts
await runCase("assistant chat prompt does not load persona memory rule or scenario stores", async () => {
  const builder = createGenerationPromptBuilder({
    config: createTestAppConfig(),
    oneBotClient: {} as any,
    audioStore: {} as any,
    audioTranscriber: { async transcribeMany() { return []; } } as any,
    npcDirectory: { listProfiles() { throw new Error("assistant should not load npc profiles"); } } as any,
    browserService: { async listPages() { return { pages: [] }; } } as any,
    localFileService: {} as any,
    chatFileStore: {} as any,
    mediaVisionService: { async prepareFilesForModel() { return []; } } as any,
    mediaCaptionService: { async ensureReady() { return new Map(); } } as any,
    globalRuleStore: { async getAll() { throw new Error("assistant should not load global rules"); } } as any,
    toolsetRuleStore: { async getAll() { throw new Error("assistant should not load toolset rules"); } } as any,
    scenarioHostStateStore: { async ensure() { throw new Error("assistant should not load scenario state"); } } as any,
    shellRuntime: { async listSessionResources() { return []; } } as any,
    setupStore: { describeMissingFields() { return []; } } as any
  });

  await builder.buildChatPromptMessages({
    sessionId: "private:10001",
    modeId: "assistant",
    interactionMode: "normal",
    mainModelRef: ["main"],
    visibleToolNames: [],
    activeToolsets: [],
    persona: { name: "ignored" } as any,
    relationship: "known",
    participantProfiles: [],
    currentUser: { userId: "10001", relationship: "known", memories: [{ title: "偏好", content: "不吃香菜" }] } as any,
    historySummary: null,
    historyForPrompt: [],
    recentToolEvents: [],
    internalTranscript: [],
    lastLlmUsage: null,
    batchMessages: [{ userId: "10001", senderName: "Tester", text: "hi", images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [], forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false, receivedAt: Date.now() }]
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/generation/generation-prompt-builder.test.tsx`  
Expected: FAIL，当前 builder 仍会读取 global/toolset/npc 等数据

- [ ] **Step 3: 在 prompt builder 中按 mode strategy 裁掉读取**

```ts
const assistantMode = input.modeId === "assistant";
const globalRules = (scenarioHostMode || assistantMode) ? [] : await deps.globalRuleStore.getAll();
const toolsetRules = (scenarioHostMode || assistantMode)
  ? []
  : resolveToolsetRules(await deps.toolsetRuleStore.getAll(), { activeToolsets: input.activeToolsets });
const npcProfiles = assistantMode ? [] : buildNpcPromptProfiles(deps, relevantUserIds);
const participantProfiles = assistantMode ? [] : input.participantProfiles;
const userProfile = assistantMode
  ? {
      ...(input.currentUser?.userId ? { userId: input.currentUser.userId } : {}),
      ...(input.batchMessages[input.batchMessages.length - 1]?.senderName ? { senderName: input.batchMessages[input.batchMessages.length - 1]?.senderName } : {})
    }
  : buildUserProfilePromptState(input.currentUser, input.batchMessages[input.batchMessages.length - 1]?.senderName);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/generation/generation-prompt-builder.test.tsx`  
Expected: PASS，assistant mode 不再访问 persona/规则/npc/scenario 存储

### Task 4: 同步 WebUI 默认占位与最终全量验证

**Files:**
- Modify: `webui/src/stores/sessions.ts`
- Modify: `test/helpers/internal-api-fixtures.tsx`
- Modify: `test/internalApi/features.test.tsx`

- [ ] **Step 1: 写失败测试，覆盖 WebUI / API 对 assistant mode 的展示**

```ts
assert.equal(modes.value.some((item) => item.id === "assistant"), true);
```

- [ ] **Step 2: 运行相关测试确认失败**

Run: `node test/internalApi/features.test.tsx`  
Expected: FAIL，返回的 mode 列表尚未包含 `assistant`

- [ ] **Step 3: 最小实现前端/测试桩同步**

```ts
modeId: "assistant"
```

只在确实需要的 fixture 默认值里同步；不要把全局默认模式从 `rp_assistant` 改成 `assistant`。

- [ ] **Step 4: 运行目标测试与全量验证**

Run: `npm run typecheck:all`  
Expected: PASS

Run: `npm run test`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/modes/assistantMode.ts src/modes/registry.ts src/llm/prompts/chat-system.prompt.ts src/llm/prompt/promptBuilder.ts src/app/generation/generationPromptBuilder.ts webui/src/stores/sessions.ts test/generation/toolset-selection-policy.test.tsx test/generation/generation-prompt-builder.test.tsx test/prompt/prompt-rendering-features.test.tsx test/tools/tool-runtime-features.test.tsx test/internalApi/features.test.tsx test/helpers/internal-api-fixtures.tsx docs/superpowers/plans/2026-04-16-assistant-mode.md
git commit -m "feat: add isolated assistant mode"
```

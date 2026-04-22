import test from "node:test";
import assert from "node:assert/strict";
import { NpcDirectory } from "../../src/identity/npcDirectory.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { buildPrompt, buildScheduledTaskPrompt, buildSetupPrompt } from "../../src/llm/prompt/promptBuilder.ts";
import { profileToolDescriptors, profileToolHandlers } from "../../src/llm/tools/profile/profileTools.ts";
import { createMemoryHarness, createMemoryTestConfig } from "../helpers/memory-test-support.tsx";
import { createPromptBatchMessage, createPromptUserProfile, readPromptMessageText } from "../helpers/prompt-fixtures.tsx";

  test("prompt builder injects persona fields and current-user memories only", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        coreIdentity: "默认会把角色边界放在前面。"
      });
      await harness.userStore.overwriteMemories("owner", [{ title: "当前用户偏好", content: "不喜欢被叫全名。" }]);
      const otherUser = await harness.userStore.overwriteMemories("20002", [{ title: "其他人记忆", content: "这个不该给当前用户用。" }]);
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [
          { userId: "owner", displayName: "Owner", relationshipLabel: "owner" },
          { userId: "20002", displayName: "Other", relationshipLabel: otherUser.relationship }
        ],
        userProfile: {},
        currentUserMemories: (await harness.userStore.getByUserId("owner"))?.memories ?? [],
        historySummary: null,
        recentMessages: [],
        recentToolEvents: [{
          toolName: "open_page",
          argsSummary: "{\"url\":\"https://example.com\"}",
          outcome: "error",
          resultSummary: "navigation timeout",
          timestampMs: Date.now()
        }],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "你好", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /基础身份=默认会把角色边界放在前面。/);
      assert.match(system, /⟦section name="current_user_memories"⟧/);
      assert.match(system, /当前触发用户长期记忆/);
      assert.match(system, /当前用户偏好：不喜欢被叫全名/);
      assert.match(system, /最近内部工具轨迹/);
      assert.match(system, /open_page/);
      assert.match(system, /navigation timeout/);
      assert.doesNotMatch(system, /角色规则/);
      assert.doesNotMatch(system, /外貌=/);
      assert.doesNotMatch(system, /这个不该给当前用户用/);
    } finally {
      await harness.cleanup();
    }
  });

  test("persona tool contract and handler only accept the new persona fields", async () => {
    const patchDescriptor = profileToolDescriptors.find((item) => item.definition.function.name === "patch_persona");
    const clearDescriptor = profileToolDescriptors.find((item) => item.definition.function.name === "clear_persona_field");
    assert.ok(patchDescriptor);
    assert.ok(clearDescriptor);

    const personaPatchProperties = Object.keys((patchDescriptor!.definition.function.parameters as {
      properties: { personaPatch: { properties: Record<string, unknown> } };
    }).properties.personaPatch.properties);
    assert.deepEqual(personaPatchProperties.sort(), [
      "background",
      "coreIdentity",
      "interests",
      "name",
      "personality",
      "speechStyle"
    ]);

    const personaFieldEnum = ((clearDescriptor!.definition.function.parameters as {
      properties: { personaField: { enum: string[] } };
    }).properties.personaField.enum) ?? [];
    assert.deepEqual([...personaFieldEnum].sort(), [
      "background",
      "coreIdentity",
      "interests",
      "name",
      "personality",
      "speechStyle"
    ]);

    const capturedPatches: Record<string, string>[] = [];
    const result = await profileToolHandlers.patch_persona!(
      { id: "tool_persona_patch_1", type: "function", function: { name: "patch_persona", arguments: "{}" } },
      {
        personaPatch: {
          name: "小满",
          role: "旧角色",
          appearance: "旧外貌",
          coreIdentity: "全局对话代理",
          personality: "克制",
          interests: "阅读",
          background: "本地运行",
          speechStyle: "简洁",
          rules: "旧规则"
        }
      },
      {
        relationship: "owner",
        personaStore: {
          isComplete(persona: Record<string, string>) {
            return Boolean(
              persona.name
              && persona.coreIdentity
              && persona.personality
              && persona.speechStyle
            );
          },
          async get() {
            return {
              name: "",
              coreIdentity: "",
              personality: "",
              interests: "",
              background: "",
              speechStyle: ""
            };
          },
          async patch(patch: Record<string, string>) {
            capturedPatches.push(patch);
            return {
              name: patch.name ?? "",
              coreIdentity: patch.coreIdentity ?? "",
              personality: patch.personality ?? "",
              interests: patch.interests ?? "",
              background: patch.background ?? "",
              speechStyle: patch.speechStyle ?? ""
            };
          }
        } as never,
        setupStore: {
          async advanceAfterPersonaUpdate(persona: unknown) {
            return persona;
          }
        } as never,
        globalProfileReadinessStore: {
          async setPersonaReadiness() {
            return null;
          }
        } as never,
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        config: {} as never,
        replyDelivery: "direct" as never,
        currentUser: null,
        requestStore: {} as never,
        sessionManager: {} as never,
        whitelistStore: {} as never,
        userStore: {} as never,
        globalRuleStore: {} as never,
        toolsetRuleStore: {} as never,
        scenarioHostStateStore: {} as never,
        conversationAccess: {} as never,
        npcDirectory: {} as never,
        scheduledJobStore: {} as never,
        scheduler: {} as never,
        messageQueue: {} as never,
        shellRuntime: {} as never,
        searchService: {} as never,
        browserService: {} as never,
        localFileService: {} as never,
        comfyClient: {} as never,
        comfyTaskStore: {} as never,
        comfyTemplateCatalog: {} as never
      } as never
    );

    assert.equal(capturedPatches.length, 1);
    assert.deepEqual(capturedPatches[0], {
      name: "小满",
      coreIdentity: "全局对话代理",
      personality: "克制",
      interests: "阅读",
      background: "本地运行",
      speechStyle: "简洁"
    });
    assert.match(String(result), /"persona":/);
    assert.doesNotMatch(String(result), /role|appearance|rules/);
  });

  test("patch_persona syncs global persona readiness after successful write", async () => {
    const readinessUpdates: Array<"uninitialized" | "ready"> = [];

    await profileToolHandlers.patch_persona!(
      { id: "tool_persona_patch_ready_1", type: "function", function: { name: "patch_persona", arguments: "{}" } },
      {
        personaPatch: {
          name: "小满",
          coreIdentity: "全局对话代理",
          personality: "克制",
          speechStyle: "简洁"
        }
      },
      {
        relationship: "owner",
        personaStore: {
          isComplete(persona: Record<string, string>) {
            return Boolean(
              persona.name
              && persona.coreIdentity
              && persona.personality
              && persona.speechStyle
            );
          },
          async patch(patch: Record<string, string>) {
            return {
              name: patch.name ?? "",
              coreIdentity: patch.coreIdentity ?? "",
              personality: patch.personality ?? "",
              interests: patch.interests ?? "",
              background: patch.background ?? "",
              speechStyle: patch.speechStyle ?? ""
            };
          }
        } as never,
        globalProfileReadinessStore: {
          async setPersonaReadiness(status: "uninitialized" | "ready") {
            readinessUpdates.push(status);
            return null;
          }
        } as never,
        setupStore: {
          async advanceAfterPersonaUpdate(persona: unknown) {
            return persona;
          }
        } as never
      } as never
    );

    assert.deepEqual(readinessUpdates, ["ready"]);
  });

  test("clear_persona_field syncs global persona readiness after successful write", async () => {
    const readinessUpdates: Array<"uninitialized" | "ready"> = [];

    await profileToolHandlers.clear_persona_field!(
      { id: "tool_persona_clear_ready_1", type: "function", function: { name: "clear_persona_field", arguments: "{}" } },
      {
        personaField: "speechStyle"
      },
      {
        relationship: "owner",
        personaStore: {
          isComplete(persona: Record<string, string>) {
            return Boolean(
              persona.name
              && persona.coreIdentity
              && persona.personality
              && persona.speechStyle
            );
          },
          async patch(patch: Record<string, string>) {
            return {
              name: "小满",
              coreIdentity: "全局对话代理",
              personality: "克制",
              interests: "",
              background: "",
              speechStyle: patch.speechStyle ?? "简洁"
            };
          }
        } as never,
        globalProfileReadinessStore: {
          async setPersonaReadiness(status: "uninitialized" | "ready") {
            readinessUpdates.push(status);
            return null;
          }
        } as never,
        setupStore: {
          async advanceAfterPersonaUpdate(persona: unknown) {
            return persona;
          }
        } as never
      } as never
    );

    assert.deepEqual(readinessUpdates, ["uninitialized"]);
  });

  test("prompt builder injects explicit current user profile card", async () => {
    const harness = await createMemoryHarness();
    try {
      await harness.userStore.registerKnownUser({ userId: "1259430720", preferredAddress: "堂弟" });
      const prompt = buildPrompt({
        sessionId: "qqbot:p:1259430720",
        persona: await harness.personaStore.get(),
        relationship: "known",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({
          userId: "1259430720",
          senderName: "阿杰",
          relationship: "known",
          preferredAddress: "堂弟",
          gender: "男",
          residence: "杭州"
        }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "1259430720", senderName: "阿杰", text: "我是你堂弟", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /当前触发用户：阿杰 \(1259430720\)/);
      assert.match(system, /当前触发用户关系：熟人$/m);
      assert.match(system, /当前触发用户补充资料：/);
      assert.match(system, /偏好称呼=堂弟/);
      assert.match(system, /性别=男/);
      assert.match(system, /住地=杭州/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder marks scheduled triggers as internal task context", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildScheduledTaskPrompt({
        sessionId: "qqbot:p:owner",
        trigger: {
          kind: "scheduled_instruction",
          jobName: "五分钟提醒",
          taskInstruction: "五分钟后提醒用户去拿外卖。"
        },
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [{ role: "user", content: "别忘了之前说过的那件事", timestampMs: Date.now() }],
        targetContext: { chatType: "private", userId: "owner", senderName: "Owner" }
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /下面这次执行是内部计划任务，不是用户刚刚发来了一条新消息/);
      assert.doesNotMatch(system, /不一定是最终发给用户的原文/);
      assert.doesNotMatch(system, /产出最终要发送给目标会话的文本/);
      assert.doesNotMatch(system, /当前时间（/);
      assert.doesNotMatch(system, /当前会话 ID：/);
      assert.equal(prompt.length, 3);
      assert.match(String(prompt[1]?.content ?? ""), /^⟦scheduled_history_message role="user" time="/);
      assert.match(String(prompt[2]?.content ?? ""), /任务名称：五分钟提醒/);
      assert.match(String(prompt[2]?.content ?? ""), /任务指令：五分钟后提醒用户去拿外卖/);
    } finally {
      await harness.cleanup();
    }
  });

  test("setup prompt stays focused on persona completion", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildSetupPrompt({
        sessionId: "qqbot:p:owner",
        persona,
        phase: "setup",
        missingFields: ["name", "coreIdentity", "personality"],
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "我叫小满，是个图书管理员", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /当前处于初始化阶段/);
      assert.match(system, /你当前只在persona的临时草稿上工作/);
      assert.match(system, /最多同时追问 1-2 个强相关字段/);
      assert.match(system, /先用工具写入能确认的字段/);
      assert.match(system, /send_setup_draft/);
      assert.match(system, /\.confirm/);
      assert.doesNotMatch(system, /不要把对话带回普通聊天或闲聊/);
      assert.doesNotMatch(system, /当前时间（/);
      assert.doesNotMatch(system, /当前会话 ID：/);
    } finally {
      await harness.cleanup();
    }
  });

  test("config prompt focuses on editing the current persona draft", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        name: "小满",
        coreIdentity: "图书管理员",
        personality: "冷静细致",
        speechStyle: "简短直接"
      });
      const prompt = buildSetupPrompt({
        sessionId: "qqbot:p:owner",
        persona,
        phase: "config",
        missingFields: [],
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "把说话方式改柔和一点", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /persona_config_mode/);
      assert.match(system, /当前处于 persona 配置阶段/);
      assert.match(system, /你当前只在persona的临时草稿上工作/);
      assert.match(system, /\.confirm，否则任何改动都不会写回正式配置/);
      assert.match(system, /只修改明确要求的字段/);
      assert.match(system, /\.cancel/);
      assert.doesNotMatch(system, /当前实例处于初始化阶段/);
      assert.doesNotMatch(system, /然后从名字和基础身份开始询问/);
    } finally {
      await harness.cleanup();
    }
  });

  test("scheduled group prompt avoids inventing a target user", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildScheduledTaskPrompt({
        sessionId: "qqbot:g:123456",
        trigger: {
          kind: "scheduled_instruction",
          jobName: "群提醒",
          taskInstruction: "到时间后在群里提醒一下前面约好的事情。"
        },
        persona,
        relationship: "known",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        targetContext: { chatType: "group", groupId: "123456" }
      });
      const system = String(prompt[0]?.content ?? "");
      assert.doesNotMatch(system, /目标会话：群聊 123456/);
      assert.doesNotMatch(system, /目标会话用户：/);
    } finally {
      await harness.cleanup();
    }
  });

  test("session manager keeps scheduled task order and ignores stale generation finish", async () => {
    const sessionManager = new SessionManager(createMemoryTestConfig());
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });

    const first = sessionManager.beginSyntheticGeneration(sessionId);
    const second = sessionManager.beginSyntheticGeneration(sessionId);
    assert.equal(sessionManager.finishGeneration(sessionId, first.abortController), false);
    assert.equal(sessionManager.isGenerating(sessionId), true);
    assert.equal(sessionManager.finishGeneration(sessionId, second.abortController), true);
    assert.equal(sessionManager.isGenerating(sessionId), false);

    sessionManager.enqueueInternalTrigger(sessionId, {
      kind: "scheduled_instruction",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "job-a",
      instruction: "first",
      enqueuedAt: 1
    });
    sessionManager.enqueueInternalTrigger(sessionId, {
      kind: "scheduled_instruction",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "job-b",
      instruction: "second",
      enqueuedAt: 2
    });

    assert.equal(sessionManager.shiftInternalTrigger(sessionId)?.jobName, "job-a");
    assert.equal(sessionManager.shiftInternalTrigger(sessionId)?.jobName, "job-b");
    assert.equal(sessionManager.shiftInternalTrigger(sessionId), null);
  });

  test("prompt builder includes npc profiles only when they are relevant to current participants", async () => {
    const harness = await createMemoryHarness();
    try {
      await harness.userStore.registerKnownUser({
        userId: "30003",
        preferredAddress: "甲",
        relationshipNote: "会一起跑剧情"
      });
      await harness.userStore.setSpecialRole("30003", "npc");
      const npcDirectory = new NpcDirectory();
      await npcDirectory.refresh(harness.userStore);
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "qqbot:g:123456",
        persona,
        relationship: "owner",
        npcProfiles: npcDirectory.listProfiles().map((item) => ({
          userId: item.userId,
          displayName: item.preferredAddress ?? item.userId,
          ...(item.preferredAddress ? { preferredAddress: item.preferredAddress } : {}),
          ...(item.relationshipNote ? { relationshipNote: item.relationshipNote } : {})
        })),
        participantProfiles: [{ userId: "30003", displayName: "NPC甲", relationshipLabel: "npc" }],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "你认识谁", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /当前相关 NPC：/);
      assert.match(system, /NPC甲/);
      assert.match(system, /会一起跑剧情/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder adds stricter stop rules for npc trigger users", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "qqbot:p:30003",
        persona,
        relationship: "known",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ specialRole: "npc" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "30003", senderName: "NPC甲", text: "嗯嗯", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /当前触发用户关系：.*；特殊角色=npc/);
      assert.match(system, /没有明确问题、请求、任务/);
      assert.match(system, /当前触发用户是 NPC\/bot；把这轮优先当成协作或任务沟通/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder renders unified bracket message headers", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "qqbot:p:10001",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "10001", senderName: "Alice", relationship: "owner" }),
        historySummary: null,
        recentMessages: [{ role: "user", content: "之前那句", timestampMs: Date.UTC(2026, 2, 16, 9, 12, 34) }],
        batchMessages: [createPromptBatchMessage({ userId: "10001", senderName: "Alice", text: "现在这句", timestampMs: Date.UTC(2026, 2, 16, 9, 13, 0) })]
      });

      assert.match(String(prompt[1]?.content ?? ""), /^⟦history_message time="2026\/03\/16 17:12:34"⟧/);
      assert.match(readPromptMessageText(prompt[2]), /^⟦trigger_batch session="私聊 10001" trigger_user="Alice \(10001\)" message_count="1" speaker_count="1"⟧/);
      assert.match(readPromptMessageText(prompt[2]), /⟦trigger_message index="1" speaker="Alice \(10001\)" trigger_user="yes" time="2026\/03\/16 17:13:00"⟧/);
    } finally {
      await harness.cleanup();
    }
  });

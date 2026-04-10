import assert from "node:assert/strict";
import { NpcDirectory } from "../../src/identity/npcDirectory.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { buildPrompt, buildScheduledTaskPrompt, buildSetupPrompt } from "../../src/llm/prompt/promptBuilder.ts";
import { createMemoryHarness, createMemoryTestConfig, runCase } from "../helpers/memory-test-support.tsx";
import { createPromptBatchMessage, createPromptUserProfile, readPromptMessageText } from "../helpers/prompt-fixtures.tsx";

async function main() {
  await runCase("prompt builder injects persona fields and current-user memories only", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        roleplayRequirements: "下雨天会更安静一点。"
      });
      await harness.userStore.overwriteMemories("owner", [{ title: "当前用户偏好", content: "不喜欢被叫全名。" }]);
      const otherUser = await harness.userStore.overwriteMemories("20002", [{ title: "其他人记忆", content: "这个不该给当前用户用。" }]);
      const prompt = buildPrompt({
        sessionId: "private:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [
          { userId: "owner", displayName: "Owner", relationshipLabel: "owner" },
          { userId: "20002", displayName: "Other", relationshipLabel: otherUser.relationship }
        ],
        userProfile: { memories: (await harness.userStore.getByUserId("owner"))?.memories ?? [] },
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
      assert.match(system, /角色边界与长期口吻：下雨天会更安静一点/);
      assert.match(system, /当前触发用户相关长期记忆/);
      assert.match(system, /当前用户偏好：不喜欢被叫全名/);
      assert.match(system, /最近内部工具轨迹/);
      assert.match(system, /open_page/);
      assert.match(system, /navigation timeout/);
      assert.doesNotMatch(system, /这个不该给当前用户用/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder injects explicit current user profile card", async () => {
    const harness = await createMemoryHarness();
    try {
      await harness.userStore.registerKnownUser({ userId: "1259430720", nickname: "小堂弟", preferredAddress: "堂弟" });
      const prompt = buildPrompt({
        sessionId: "private:1259430720",
        persona: await harness.personaStore.get(),
        relationship: "known",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({
          userId: "1259430720",
          senderName: "阿杰",
          nickname: "小堂弟",
          relationship: "known",
          preferredAddress: "堂弟",
          gender: "男",
          residence: "杭州",
          specialRole: "none"
        }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "1259430720", senderName: "阿杰", text: "我是你堂弟", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /当前触发用户：阿杰 \(1259430720\)/);
      assert.match(system, /当前触发用户关系：熟人；特殊角色=none/);
      assert.match(system, /当前触发用户补充资料：/);
      assert.match(system, /档案昵称=小堂弟/);
      assert.match(system, /偏好称呼=堂弟/);
      assert.match(system, /性别=男/);
      assert.match(system, /住地=杭州/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder marks scheduled triggers as internal task context", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildScheduledTaskPrompt({
        sessionId: "private:owner",
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

  await runCase("setup prompt stays focused on persona completion", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildSetupPrompt({
        sessionId: "private:owner",
        persona,
        missingFields: ["name", "identity", "personality"],
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "我叫小满，是个图书管理员", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /只做 owner 的 persona 设定补全/);
      assert.match(system, /先写入再继续确认/);
      assert.doesNotMatch(system, /不要把对话带回普通聊天或闲聊/);
      assert.doesNotMatch(system, /当前时间（/);
      assert.doesNotMatch(system, /当前会话 ID：/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("scheduled group prompt avoids inventing a target user", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildScheduledTaskPrompt({
        sessionId: "group:123456",
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

  await runCase("session manager keeps scheduled task order and ignores stale generation finish", async () => {
    const sessionManager = new SessionManager(createMemoryTestConfig());
    const sessionId = "private:owner";
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

  await runCase("prompt builder includes npc profiles only when they are relevant to current participants", async () => {
    const harness = await createMemoryHarness();
    try {
      await harness.userStore.registerKnownUser({
        userId: "30003",
        nickname: "NPC甲",
        preferredAddress: "甲",
        sharedContext: "会一起跑剧情"
      });
      await harness.userStore.setSpecialRole("30003", "npc");
      const npcDirectory = new NpcDirectory();
      await npcDirectory.refresh(harness.userStore);
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "group:123456",
        persona,
        relationship: "owner",
        npcProfiles: npcDirectory.listProfiles().map((item) => ({
          userId: item.userId,
          displayName: item.nickname ?? item.userId,
          preferredAddress: item.preferredAddress ?? item.userId,
          ...(item.sharedContext ? { sharedContext: item.sharedContext } : {})
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

  await runCase("prompt builder adds stricter stop rules for npc trigger users", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "private:30003",
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

  await runCase("prompt builder renders unified bracket message headers", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "private:10001",
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

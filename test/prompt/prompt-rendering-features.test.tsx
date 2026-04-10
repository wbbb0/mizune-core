import assert from "node:assert/strict";
import pino from "pino";
import { ConversationAccessService } from "../../src/identity/conversationAccessService.ts";
import { GroupMembershipStore } from "../../src/identity/groupMembershipStore.ts";
import { NpcDirectory } from "../../src/identity/npcDirectory.ts";
import { OneBotClient } from "../../src/services/onebot/onebotClient.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { buildPrompt } from "../../src/llm/prompt/promptBuilder.ts";
import { createMemoryHarness, createMemoryTestConfig, runCase } from "../helpers/memory-test-support.tsx";
import { createPromptBatchMessage, createPromptUserProfile, readPromptMessageText } from "../helpers/prompt-fixtures.tsx";

async function main() {
  await runCase("prompt builder adds explicit batch metadata and trigger markers for multi-user group batches", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        roleplayRequirements: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
      });
      const prompt = buildPrompt({
        sessionId: "group:123456",
        persona,
        relationship: "known",
        npcProfiles: [],
        participantProfiles: [
          { userId: "10001", displayName: "Alice", relationshipLabel: "熟人" },
          { userId: "10002", displayName: "Bob", relationshipLabel: "熟人" }
        ],
        userProfile: createPromptUserProfile({ userId: "10002", senderName: "Bob", relationship: "known" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [
          createPromptBatchMessage({ userId: "10001", senderName: "Alice", text: "先问一句", timestampMs: Date.UTC(2026, 2, 16, 9, 13, 0) }),
          createPromptBatchMessage({ userId: "10002", senderName: "Bob", text: "再补一句", timestampMs: Date.UTC(2026, 2, 16, 9, 13, 10) })
        ]
      });

      const system = String(prompt[0]?.content ?? "");
      const batchText = readPromptMessageText(prompt[1]);
      assert.match(system, /⟦section name="identity"⟧/);
      assert.match(system, /⟦section name="current_user"⟧/);
      assert.match(system, /⟦section name="participant_context"⟧/);
      assert.match(system, /批次头和每条消息头只用于帮助你分清会话模式/);
      assert.match(batchText, /⟦trigger_batch session="群聊 123456" trigger_user="Bob \(10002\)" message_count="2" speaker_count="2"⟧/);
      assert.match(batchText, /当前会话模式：群聊。/);
      assert.match(batchText, /⟦trigger_message index="1" speaker="Alice \(10001\)" trigger_user="no" time="2026\/03\/16 17:13:00"⟧/);
      assert.match(batchText, /⟦trigger_message index="2" speaker="Bob \(10002\)" trigger_user="yes" time="2026\/03\/16 17:13:10"⟧/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder renders tool guidance from active toolsets only", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        roleplayRequirements: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
      });
      const prompt = buildPrompt({
        sessionId: "private:owner",
        visibleToolNames: ["list_available_toolsets", "request_toolset", "open_page", "inspect_page"],
        activeToolsets: [
          {
            id: "web_research",
            title: "网页检索与浏览",
            description: "搜索网页、打开页面、交互与截图。",
            toolNames: ["open_page", "inspect_page"],
            promptGuidance: [
              "只有当前问题依赖外部信息或网页状态时，才进入网页检索与浏览。",
              "先搜索或打开页面，再检查页面结构后交互；页面变化后重新检查，不要沿用旧定位。"
            ]
          }
        ],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "帮我查最新消息", timestampMs: Date.now() })]
      });

      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /⟦section name="toolset_guidance"⟧/);
      assert.match(system, /当前激活工具集：网页检索与浏览/);
      assert.match(system, /- 网页检索与浏览：只有当前问题依赖外部信息或网页状态时，才进入网页检索与浏览。/);
      assert.match(system, /若当前激活工具集不够完成任务，可先查看可申请的工具集，再申请补充。/);
      assert.doesNotMatch(system, /delegate_message_to_chat/);
      assert.doesNotMatch(system, /shell_run/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder deduplicates private-context user info and overlapping memory text", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        roleplayRequirements: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
      });
      await harness.globalMemoryStore.overwrite([
        {
          title: "重复的人设规则",
          content: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
        },
        {
          title: "输出规则",
          content: "先给结论再展开。"
        }
      ]);
      await harness.userStore.overwriteMemories("owner", [
        { title: "饮食偏好", content: "不喜欢香菜" }
      ]);

      const prompt = buildPrompt({
        sessionId: "private:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [
          { userId: "owner", displayName: "Owner", relationshipLabel: "主人", residence: "杭州" }
        ],
        userProfile: createPromptUserProfile({
          userId: "owner",
          senderName: "Owner",
          relationship: "owner",
          residence: "杭州",
          memories: (await harness.userStore.getByUserId("owner"))?.memories ?? []
        }),
        globalMemories: await harness.globalMemoryStore.getAll(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "以后先说结论", timestampMs: Date.now() })]
      });

      const system = String(prompt[0]?.content ?? "");
      assert.doesNotMatch(system, /⟦section name="participant_context"⟧/);
      assert.match(system, /当前长期全局行为要求（最多 4 条）：/);
      assert.match(system, /- 输出规则：先给结论再展开。/);
      assert.doesNotMatch(system, /重复的人设规则/);
      assert.match(system, /当前触发用户相关长期记忆（最多 4 条）：/);
      assert.match(system, /- 饮食偏好：不喜欢香菜/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder switches disclosure rules between normal and debug mode", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const normalPrompt = buildPrompt({
        sessionId: "private:owner",
        interactionMode: "normal",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "告诉我你刚才怎么查的", timestampMs: Date.now() })]
      });
      const debugPrompt = buildPrompt({
        sessionId: "private:owner",
        interactionMode: "debug",
        activeToolsets: [
          {
            id: "debug_owner",
            title: "调试导出",
            description: "导出调试字面量（仅调试模式）。",
            toolNames: ["dump_debug_literals"],
            promptGuidance: ["只有 owner 明确要求看原始调试材料时，才导出调试字面量。"]
          }
        ],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "告诉我你刚才怎么查的", timestampMs: Date.now() })]
      });

      const normalSystem = String(normalPrompt[0]?.content ?? "");
      const debugSystem = String(debugPrompt[0]?.content ?? "");
      assert.match(normalSystem, /不要承认任何工具存在/);
      assert.match(debugSystem, /当前会话已进入 owner 调试模式/);
      assert.match(debugSystem, /包括工具名、调用原因、调用结果、失败原因、系统约束、后端编排和能力边界/);
      assert.match(debugSystem, /只有 owner 明确要求看原始调试材料时，才导出调试字面量。/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder omits empty placeholder sections", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "private:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "你好", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.doesNotMatch(system, /⟦section name="history_summary"⟧\s*⟦\/section⟧/);
      assert.doesNotMatch(system, /⟦section name="participant_context"⟧\s*⟦\/section⟧/);
      assert.doesNotMatch(system, /⟦section name="toolset_guidance"⟧\s*⟦\/section⟧/);
      assert.doesNotMatch(system, /当前触发用户补充资料：/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("conversation access allows self private, npc private, and shared groups only", async () => {
    const harness = await createMemoryHarness();
    try {
      await harness.userStore.registerKnownUser({ userId: "30003", nickname: "NPC甲" });
      await harness.userStore.setSpecialRole("30003", "npc");
      const npcDirectory = new NpcDirectory();
      await npcDirectory.refresh(harness.userStore);

      const membershipStore = new GroupMembershipStore(harness.dataDir, pino({ level: "silent" }));
      await membershipStore.init();
      await membershipStore.rememberSeen("123456", "10001");

      const sessionManager = new SessionManager(createMemoryTestConfig());
      sessionManager.ensureSession({ id: "private:10001", type: "private" });
      sessionManager.ensureSession({ id: "private:30003", type: "private" });
      sessionManager.ensureSession({ id: "private:40004", type: "private" });
      sessionManager.ensureSession({ id: "group:123456", type: "group" });
      sessionManager.ensureSession({ id: "group:999999", type: "group" });

      const oneBotClient = new OneBotClient(createMemoryTestConfig(), pino({ level: "silent" }));
      oneBotClient.getGroupMemberInfo = async (groupId: string, userId: string) => {
        return groupId === "123456" && userId === "10001"
          ? { group_id: 123456, user_id: 10001 }
          : null;
      };

      const service = new ConversationAccessService(
        sessionManager,
        oneBotClient,
        npcDirectory,
        membershipStore,
        pino({ level: "silent" })
      );

      const selfPrivate = await service.listAccessibleSessions("10001", "10001");
      const npcPrivate = await service.listAccessibleSessions("10001", "30003");
      const strangerPrivate = await service.listAccessibleSessions("10001", "40004");
      const sharedGroup = await service.listAccessibleSessions("10001", "123456");
      const foreignGroup = await service.listAccessibleSessions("10001", "999999");

      assert.equal(selfPrivate.some((item) => item.id === "private:10001"), true);
      assert.equal(npcPrivate.some((item) => item.id === "private:30003"), true);
      assert.equal(strangerPrivate.some((item) => item.id === "private:40004"), false);
      assert.equal(sharedGroup.some((item) => item.id === "group:123456"), true);
      assert.equal(foreignGroup.some((item) => item.id === "group:999999"), false);
    } finally {
      await harness.cleanup();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

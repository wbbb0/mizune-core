import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ConversationAccessService } from "../../src/identity/conversationAccessService.ts";
import { GroupMembershipStore } from "../../src/identity/groupMembershipStore.ts";
import { NpcDirectory } from "../../src/identity/npcDirectory.ts";
import { OneBotClient } from "../../src/services/onebot/onebotClient.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { buildPrompt } from "../../src/llm/prompt/promptBuilder.ts";
import { createMemoryHarness, createMemoryTestConfig } from "../helpers/memory-test-support.tsx";
import { createPromptBatchMessage, createPromptUserProfile, readPromptMessageText } from "../helpers/prompt-fixtures.tsx";

  test("prompt builder adds explicit batch metadata and trigger markers for multi-user group batches", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        rules: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
      });
      const prompt = buildPrompt({
        sessionId: "qqbot:g:123456",
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
      assert.match(system, /⟦section name="persona"⟧/);
      assert.match(system, /⟦section name="current_user_profile"⟧/);
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

  test("prompt builder renders tool guidance from active toolsets only", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        rules: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
      });
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
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

  test("prompt builder deduplicates private-context user info and overlapping memory text", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        rules: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
      });
      await harness.globalRuleStore.overwrite([
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
        { title: "饮食偏好", content: "不喜欢香菜" },
        { title: "作息", content: "经常熬夜" }
      ]);

      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
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
          timezone: "Asia/Shanghai",
          occupation: "产品经理",
          profileSummary: "不喜欢香菜。经常先给结论。"
        }),
        currentUserMemories: (await harness.userStore.getByUserId("owner"))?.memories ?? [],
        globalRules: await harness.globalRuleStore.getAll(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "以后先说结论", timestampMs: Date.now() })]
      });

      const system = String(prompt[0]?.content ?? "");
      assert.doesNotMatch(system, /⟦section name="participant_context"⟧/);
      assert.match(system, /当前长期全局行为规则（最多 4 条）：/);
      assert.match(system, /- 输出规则：先给结论再展开。/);
      assert.doesNotMatch(system, /重复的人设规则/);
      assert.match(system, /⟦section name="current_user_profile"⟧/);
      assert.match(system, /⟦section name="current_user_memories"⟧/);
      assert.match(system, /时区=Asia\/Shanghai/);
      assert.match(system, /职业=产品经理/);
      assert.match(system, /用户画像=经常先给结论/);
      assert.doesNotMatch(system, /用户画像=.*不喜欢香菜/);
      assert.match(system, /当前触发用户长期记忆（最多 4 条）：/);
      assert.match(system, /- 饮食偏好：不喜欢香菜/);
      assert.match(system, /- 作息：经常熬夜/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder keeps higher-priority rules and ranks user memories by kind and importance", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        role: "嘴硬但靠谱的搭档"
      });
      await harness.globalRuleStore.overwrite([
        {
          title: "输出顺序",
          content: "先给结论再展开。"
        }
      ]);
      await harness.userStore.overwriteMemories("owner", [
        {
          title: "输出顺序",
          content: "先给结论再展开。",
          kind: "fact",
          updatedAt: Date.now(),
          createdAt: Date.now()
        },
        {
          title: "交流边界",
          content: "不要替我做决定。",
          kind: "boundary",
          importance: 5,
          updatedAt: Date.now() - (90 * 24 * 60 * 60 * 1000),
          createdAt: Date.now() - (90 * 24 * 60 * 60 * 1000)
        },
        {
          title: "饮食偏好",
          content: "不喜欢香菜。",
          kind: "fact",
          updatedAt: Date.now(),
          createdAt: Date.now()
        }
      ]);

      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({
          userId: "owner",
          senderName: "Owner",
          relationship: "owner"
        }),
        currentUserMemories: (await harness.userStore.getByUserId("owner"))?.memories ?? [],
        globalRules: await harness.globalRuleStore.getAll(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "记住这些", timestampMs: Date.now() })]
      });

      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /- 输出顺序：先给结论再展开。/);
      assert.doesNotMatch(system, /当前触发用户长期记忆（最多 4 条）：\n- 输出顺序：先给结论再展开。/);
      const boundaryIndex = system.indexOf("交流边界：不要替我做决定。");
      const factIndex = system.indexOf("饮食偏好：不喜欢香菜。");
      assert.ok(boundaryIndex >= 0);
      assert.ok(factIndex >= 0);
      assert.ok(boundaryIndex < factIndex);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder switches disclosure rules between normal and debug mode", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const normalPrompt = buildPrompt({
        sessionId: "qqbot:p:owner",
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
        sessionId: "qqbot:p:owner",
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

  test("prompt builder omits empty placeholder sections", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
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

  test("assistant mode keeps message headers but excludes rp and memory sections", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        name: "Bot",
        role: "角色助手",
        personality: "冷静",
        speechStyle: "简洁",
        rules: "始终带角色口吻"
      });
      const prompt = buildPrompt({
        sessionId: "qqbot:g:123456",
        modeId: "assistant",
        persona,
        relationship: "known",
        npcProfiles: [
          { userId: "npc_1", displayName: "Npc" }
        ],
        participantProfiles: [
          { userId: "10001", displayName: "Alice", relationshipLabel: "熟人" }
        ],
        userProfile: createPromptUserProfile({ userId: "10002", senderName: "Bob", relationship: "known", residence: "杭州" }),
        currentUserMemories: [{
          id: "mem_1",
          title: "饮食偏好",
          content: "不吃香菜",
          kind: "preference",
          source: "user_explicit",
          createdAt: 1,
          updatedAt: 1
        }],
        globalRules: [{
          id: "rule_1",
          title: "输出规则",
          content: "先给结论",
          kind: "workflow",
          source: "owner_explicit",
          createdAt: 1,
          updatedAt: 1
        }],
        historySummary: "之前聊过搜索和文件处理。",
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
      assert.doesNotMatch(system, /⟦section name="participant_context"⟧/);
      assert.match(system, /普通中文 assistant/);
      assert.match(batchText, /⟦trigger_batch session="群聊 123456" trigger_user="Bob \(10002\)" message_count="1" speaker_count="1"⟧/);
      assert.match(batchText, /⟦trigger_message index="1" speaker="Bob \(10002\)" trigger_user="yes" time="2026\/03\/16 17:13:10"⟧/);
    } finally {
      await harness.cleanup();
    }
  });

  test("scenario_host rewrites prefixed user inputs for batch and history while normal mode keeps raw text", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const scenarioPrompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        modeId: "scenario_host",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner", relationship: "owner" }),
        historySummary: null,
        recentMessages: [
          { role: "user", content: "*推开钟楼木门", timestampMs: Date.UTC(2026, 2, 16, 9, 10, 0) },
          { role: "user", content: "#别推进太快", timestampMs: Date.UTC(2026, 2, 16, 9, 10, 10) },
          { role: "user", content: "里面有人吗", timestampMs: Date.UTC(2026, 2, 16, 9, 10, 20) }
        ],
        batchMessages: [
          createPromptBatchMessage({
            userId: "owner",
            senderName: "Owner",
            text: "*我先把提灯举高",
            timestampMs: Date.UTC(2026, 2, 16, 9, 13, 10)
          }),
          createPromptBatchMessage({
            userId: "owner",
            senderName: "Owner",
            text: "#先不要替我做决定",
            timestampMs: Date.UTC(2026, 2, 16, 9, 13, 20)
          }),
          createPromptBatchMessage({
            userId: "owner",
            senderName: "Owner",
            text: "你是谁",
            timestampMs: Date.UTC(2026, 2, 16, 9, 13, 30)
          })
        ]
      });

      assert.match(String(scenarioPrompt[1]?.content ?? ""), /玩家动作：推开钟楼木门/);
      assert.match(String(scenarioPrompt[2]?.content ?? ""), /场外指令：别推进太快/);
      assert.match(String(scenarioPrompt[3]?.content ?? ""), /玩家对白：里面有人吗/);

      const scenarioBatchText = readPromptMessageText(scenarioPrompt[4]);
      assert.match(scenarioBatchText, /玩家动作：我先把提灯举高/);
      assert.match(scenarioBatchText, /场外指令：先不要替我做决定/);
      assert.match(scenarioBatchText, /玩家对白：你是谁/);

      const normalPrompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner", relationship: "owner" }),
        historySummary: null,
        recentMessages: [
          { role: "user", content: "*推开钟楼木门", timestampMs: Date.UTC(2026, 2, 16, 9, 10, 0) }
        ],
        batchMessages: [
          createPromptBatchMessage({
            userId: "owner",
            senderName: "Owner",
            text: "#先不要替我做决定",
            timestampMs: Date.UTC(2026, 2, 16, 9, 13, 20)
          })
        ]
      });

      assert.match(String(normalPrompt[1]?.content ?? ""), /\*推开钟楼木门/);
      assert.doesNotMatch(String(normalPrompt[1]?.content ?? ""), /玩家动作：/);
      const normalBatchText = readPromptMessageText(normalPrompt[2]);
      assert.match(normalBatchText, /#先不要替我做决定/);
      assert.doesNotMatch(normalBatchText, /场外指令：/);
    } finally {
      await harness.cleanup();
    }
  });

  test("conversation access allows self private, npc private, and shared groups only", async () => {
    const harness = await createMemoryHarness();
    try {
      await harness.userStore.registerKnownUser({ userId: "30003" });
      await harness.userStore.setSpecialRole("30003", "npc");
      const npcDirectory = new NpcDirectory();
      await npcDirectory.refresh(harness.userStore);

      const membershipStore = new GroupMembershipStore(harness.dataDir, pino({ level: "silent" }));
      await membershipStore.init();
      await membershipStore.rememberSeen("123456", "10001");

      const sessionManager = new SessionManager(createMemoryTestConfig());
      sessionManager.ensureSession({ id: "qqbot:p:10001", type: "private" });
      sessionManager.ensureSession({ id: "qqbot:p:30003", type: "private" });
      sessionManager.ensureSession({ id: "qqbot:p:40004", type: "private" });
      sessionManager.ensureSession({ id: "qqbot:g:123456", type: "group" });
      sessionManager.ensureSession({ id: "qqbot:g:999999", type: "group" });

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

      assert.equal(selfPrivate.some((item) => item.id === "qqbot:p:10001"), true);
      assert.equal(npcPrivate.some((item) => item.id === "qqbot:p:30003"), true);
      assert.equal(strangerPrivate.some((item) => item.id === "qqbot:p:40004"), false);
      assert.equal(sharedGroup.some((item) => item.id === "qqbot:g:123456"), true);
      assert.equal(foreignGroup.some((item) => item.id === "qqbot:g:999999"), false);
    } finally {
      await harness.cleanup();
    }
  });

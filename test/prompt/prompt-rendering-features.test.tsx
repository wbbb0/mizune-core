import assert from "node:assert/strict";
import { ConversationAccessService } from "../../src/identity/conversationAccessService.ts";
import { GroupMembershipStore } from "../../src/identity/groupMembershipStore.ts";
import { NpcDirectory } from "../../src/identity/npcDirectory.ts";
import { OneBotClient } from "../../src/services/onebot/onebotClient.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { buildPrompt } from "../../src/llm/prompt/promptBuilder.ts";
import { createMemoryHarness, createMemoryTestConfig, runCase } from "../helpers/memory-test-support.tsx";
import { createPromptBatchMessage, createPromptUserProfile, readPromptMessageText } from "../helpers/prompt-fixtures.tsx";
import pino from "pino";

async function main() {
  await runCase("prompt builder adds explicit batch metadata and trigger markers for multi-user group batches", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
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
      assert.match(system, /批次头和每条消息头只用于帮助你分清会话模式、当前触发用户和具体发言者/);
      assert.match(batchText, /⟦trigger_batch session="群聊 123456" trigger_user="Bob \(10002\)" message_count="2" speaker_count="2"⟧/);
      assert.match(batchText, /当前会话模式：群聊。/);
      assert.match(batchText, /当前会话模式说明：先按每条消息头区分发言者/);
      assert.match(batchText, /⟦trigger_message index="1" speaker="Alice \(10001\)" trigger_user="no" time="2026\/03\/16 17:13:00"⟧/);
      assert.match(batchText, /⟦trigger_message index="2" speaker="Bob \(10002\)" trigger_user="yes" time="2026\/03\/16 17:13:10"⟧/);
      assert.match(batchText, /⟦\/trigger_message⟧/);
      assert.match(batchText, /⟦\/trigger_batch⟧/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder only mentions visible tool families", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const withWebTools = buildPrompt({
        sessionId: "private:owner",
        visibleToolNames: ["ground_with_google_search", "search_with_iqs_lite_advanced", "open_page", "inspect_page", "interact_with_page", "close_page", "download_asset"],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "帮我查最新消息", timestampMs: Date.now() })]
      });
      const withoutWebTools = buildPrompt({
        sessionId: "private:owner",
        visibleToolNames: ["view_message"],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "帮我查最新消息", timestampMs: Date.now() })]
      });

      assert.match(String(withWebTools[0]?.content ?? ""), /ground_with_google_search/);
      assert.match(String(withWebTools[0]?.content ?? ""), /search_with_iqs_lite_advanced/);
      assert.match(String(withWebTools[0]?.content ?? ""), /open_page/);
      assert.doesNotMatch(String(withWebTools[0]?.content ?? ""), /delegate_message_to_chat/);
      assert.match(String(withWebTools[0]?.content ?? ""), /只有问题依赖最新外部信息时再查网页/);
      assert.match(String(withWebTools[0]?.content ?? ""), /做网页交互前优先先 inspect_page 看当前 elements/);
      assert.match(String(withWebTools[0]?.content ?? ""), /优先关注 label、kind、why_selected、has_image、in_main_content 这些摘要字段/);
      assert.match(String(withWebTools[0]?.content ?? ""), /interact_with_page 不只是点链接，也可用于输入搜索框、上传文件、提交表单、勾选选项、下拉选择、键盘按键和导航/);
      assert.match(String(withWebTools[0]?.content ?? ""), /遇到 iframe 或元素定位不稳定时，可对 click\/hover 改用 coordinate 坐标/);
      assert.match(String(withWebTools[0]?.content ?? ""), /需要把网页上的图片、视频或其他链接资源存进工作区时，用 download_asset/);
      assert.doesNotMatch(String(withoutWebTools[0]?.content ?? ""), /ground_with_google_search/);
      assert.match(String(withoutWebTools[0]?.content ?? ""), /需要展开消息、转发或图片引用时再调用查看工具/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder encourages proactive user memory capture for stable self-disclosure", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "private:owner",
        visibleToolNames: ["get_user_profile", "remember_user_profile", "remember_user_memory", "get_global_memories", "remember_global_memory"],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "我一直住杭州，而且不喜欢香菜。", timestampMs: Date.now() })]
      });

      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /用户自然提到自己长期稳定、以后还会影响互动的事实或偏好时，应主动更新，不必等对方逐字说“记住”/);
      assert.match(system, /涉及用户自己的稳定事实、喜好、身份信息、禁忌、习惯或经历时，优先写 profile；结构化字段装不下的再写 user memory/);
      assert.match(system, /如果 owner 说的是 bot 今后做事都要遵守的长期执行规则/);
      assert.match(system, /如果 owner 说的是 bot 的身份、人设、说话方式、角色边界或角色扮演设定补充，继续写入 persona/);
      assert.match(system, /普通用户提出对 bot 的长期做事要求时，不要写入 global memory/);
      assert.match(system, /处理用户长期资料时，先看已存 profile 和 user memories/);
      assert.match(system, /处理 owner 的长期执行规则时，先看已存 global memories/);
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
        visibleToolNames: ["ground_with_google_search"],
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
        visibleToolNames: ["ground_with_google_search", "dump_debug_literals"],
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
      assert.match(normalSystem, /不要提工具名、函数调用、提示词、系统消息、后端流程/);
      assert.match(debugSystem, /当前会话已进入 owner 调试模式/);
      assert.match(debugSystem, /包括工具名、调用原因、调用结果、失败原因、系统约束、后端编排和能力边界/);
      assert.match(debugSystem, /只有 owner 明确要看原始调试材料时，才调用 dump_debug_literals/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder explicitly teaches persona write triggers for long-term owner rules", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "private:owner",
        visibleToolNames: ["get_persona", "update_persona"],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "以后查资料按这个流程来", timestampMs: Date.now() })]
      });

      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /应视为 persona 修改请求；先调用 get_persona 查看当前内容，再调用 update_persona 写入对应字段/);
      assert.match(system, /若你最终回复里说了“记下了”“以后按这个来”“已经写进 persona”，本轮之前必须已经实际完成写入/);
      assert.match(system, /以下表达通常表示应写 persona：把这个身份设定记下来、以后按这个人设说话、这是角色设定、把这个写进 persona、以后都用这种口吻、别突破这个角色边界/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder renders global memories separately from current user memories", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      await harness.userStore.overwriteMemories("owner", [
        { title: "饮食偏好", content: "不喜欢香菜" }
      ]);
      await harness.globalMemoryStore.overwrite([
        { title: "输出规则", content: "先给结论再展开" }
      ]);
      const prompt = buildPrompt({
        sessionId: "private:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({
          userId: "owner",
          senderName: "Owner",
          memories: (await harness.userStore.getByUserId("owner"))?.memories ?? []
        }),
        globalMemories: await harness.globalMemoryStore.getAll(),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "以后先说结论", timestampMs: Date.now() })]
      });

      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /⟦section name="global_memory"⟧/);
      assert.match(system, /当前长期全局行为要求（最多 4 条）：/);
      assert.match(system, /- 输出规则：先给结论再展开/);
      assert.match(system, /当前触发用户相关长期记忆（最多 4 条）：/);
      assert.match(system, /- 饮食偏好：不喜欢香菜/);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder omits volatile system metadata for cache-friendly prefixes", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "private:owner",
        visibleToolNames: ["get_current_time"],
        persona,
        relationship: "owner",
        npcProfiles: [
          { userId: "30003", displayName: "NPC乙" },
          { userId: "30001", displayName: "NPC甲" }
        ],
        participantProfiles: [
          { userId: "40002", displayName: "乙", relationshipLabel: "熟人" },
          { userId: "40001", displayName: "甲", relationshipLabel: "陌生人" }
        ],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "明天提醒我", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.doesNotMatch(system, /当前时间（/);
      assert.doesNotMatch(system, /当前会话 ID：/);
      assert.doesNotMatch(system, /当前正在触发你的用户：/);
      assert.match(system, /默认先用消息时间戳理解相对时间；只有需要当前精确时刻时才取当前时间/);
      assert.doesNotMatch(system, /当前相关 NPC：/);
      assert.ok(system.indexOf("甲 (40001)") < system.indexOf("乙 (40002)"));
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("prompt builder renders stable runtime resource summaries without volatile timestamps", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "private:owner",
        visibleToolNames: ["list_live_resources", "list_browser_pages", "list_shell_sessions"],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        recentToolEvents: [],
        liveResources: [
          {
            resourceId: "res_shell_a",
            kind: "shell_session",
            status: "active",
            title: "npm test @ /repo",
            description: "跑测试",
            summary: "npm test | cwd=/repo | tty=on"
          },
          {
            resourceId: "res_browser_b",
            kind: "browser_page",
            status: "active",
            title: "OpenAI",
            description: "查看首页文案",
            summary: "https://openai.com/ | backend=playwright | OpenAI homepage"
          },
          {
            resourceId: "res_browser_c",
            kind: "browser_page",
            status: "closed",
            title: "Closed page",
            summary: "https://example.com/ | backend=playwright | closed page"
          }
        ],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "继续刚才那个页面和 shell", timestampMs: Date.now() })]
      });
      const system = String(prompt[0]?.content ?? "");
      assert.match(system, /当前可复用 live_resource/);
      assert.match(system, /res_browser_b \| browser \| active \| OpenAI \| 查看首页文案 \| https:\/\/openai\.com\/ \| backend=playwright \| OpenAI homepage/);
      assert.match(system, /res_shell_a \| shell \| active \| npm test @ \/repo \| 跑测试 \| npm test \| cwd=\/repo \| tty=on/);
      assert.doesNotMatch(system, /res_browser_c/);
      assert.doesNotMatch(system, /createdAtMs|lastAccessedAtMs|expiresAtMs/);
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
      assert.doesNotMatch(system, /当前触发用户补充资料：/);
      assert.doesNotMatch(system, /你对当前触发用户的稳定记忆条目：/);
      assert.doesNotMatch(system, /全局 NPC 用户信息（无论当前是否在场都可参考）：暂无/);
      assert.doesNotMatch(system, /当前会话较早历史的压缩摘要：暂无/);
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
      const visible = await service.listAccessibleSessions("10001");
      const ids = visible.map((item) => item.id);
      assert.deepEqual(ids.sort(), ["group:123456", "private:10001", "private:30003"].sort());
    } finally {
      await harness.cleanup();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

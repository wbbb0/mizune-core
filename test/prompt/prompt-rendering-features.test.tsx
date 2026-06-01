import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ConversationAccessService } from "../../src/identity/conversationAccessService.ts";
import { GroupMembershipStore } from "../../src/identity/groupMembershipStore.ts";
import { NpcDirectory } from "../../src/identity/npcDirectory.ts";
import { OneBotClient } from "../../src/services/onebot/onebotClient.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { buildPrompt, buildScheduledTaskPrompt, buildSetupPrompt } from "../../src/llm/prompt/promptBuilder.ts";
import { createMemoryHarness, createMemoryTestConfig } from "../helpers/memory-test-support.tsx";
import {
  createPromptBatchMessage,
  createPromptUserProfile,
  findPromptBlock,
  findPromptSection,
  hasPromptSection,
  parsePromptBlocks,
  readPromptLastMessageText,
  readPromptSystemText
} from "../helpers/prompt-fixtures.tsx";
import type { SessionTaskTracker } from "../../src/conversation/taskTracker/taskTrackerTypes.ts";

  test("prompt builder adds explicit batch metadata and trigger markers for multi-user group batches", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        speakingStyle: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
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

      const system = readPromptSystemText(prompt);
      const batchText = readPromptLastMessageText(prompt);
      assert.equal(hasPromptSection(system, "global_persona"), true);
      assert.equal(hasPromptSection(system, "current_user_profile"), true);
      assert.equal(hasPromptSection(system, "participant_context"), true);
      assert.match(system, /批次头和每条消息头只用于帮助你分清会话模式/);
      const batch = findPromptBlock(batchText, "trigger_batch");
      assert.equal(batch?.attrs.session, "群聊 123456");
      assert.equal(batch?.attrs.trigger_user, "Bob (10002)");
      assert.equal(batch?.attrs.message_count, "2");
      assert.equal(batch?.attrs.speaker_count, "2");
      assert.match(batchText, /当前会话模式：群聊。/);
      const messages = parsePromptBlocks(batchText).filter((block) => block.tag === "trigger_message");
      assert.deepEqual(messages.map((message) => message.attrs), [
        { index: "1", speaker: "Alice (10001)", trigger_user: "no", time: "2026/03/16 17:13:00" },
        { index: "2", speaker: "Bob (10002)", trigger_user: "yes", time: "2026/03/16 17:13:10" }
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder appends current turn directives inside the current user batch", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "qqbot:g:123456",
        persona,
        relationship: "known",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "10002", senderName: "Bob", relationship: "known" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [
          createPromptBatchMessage({ userId: "10002", senderName: "Bob", text: "当前问题" })
        ],
        currentTurnDirectives: ["本轮回复目标：\n- user_id: 10002"]
      });

      assert.equal(prompt.at(-1)?.role, "user");
      assert.match(readPromptLastMessageText(prompt), /%%llmbot:section name="current_turn_directives"/);
      assert.match(readPromptLastMessageText(prompt), /本轮回复目标/);
    } finally {
      await harness.cleanup();
    }
  });

  test("setup prompt appends current turn directives inside the setup user batch", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildSetupPrompt({
        sessionId: "qqbot:p:owner",
        interactionMode: "normal",
        persona,
        phase: "setup",
        missingFields: ["name", "temperament", "speakingStyle"],
        recentMessages: [],
        batchMessages: [
          createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "继续设置" })
        ],
        currentTurnDirectives: ["本轮配置目标：继续 persona 初始化"]
      });

      assert.equal(prompt.at(-1)?.role, "user");
      assert.match(readPromptLastMessageText(prompt), /%%llmbot:section name="current_turn_directives"/);
      assert.match(readPromptLastMessageText(prompt), /本轮配置目标/);
    } finally {
      await harness.cleanup();
    }
  });

  test("scheduled prompt appends current turn directives inside the trigger user message", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildScheduledTaskPrompt({
        sessionId: "qqbot:p:owner",
        visibleToolNames: [],
        activeToolsets: [],
        trigger: {
          kind: "scheduled_instruction",
          jobName: "提醒",
          taskInstruction: "提醒用户喝水。"
        },
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        targetContext: { chatType: "private", userId: "owner", senderName: "Owner" },
        currentTurnDirectives: ["本轮计划任务目标：只发送提醒正文"]
      });

      assert.equal(prompt.at(-1)?.role, "user");
      assert.match(readPromptLastMessageText(prompt), /%%llmbot:section name="current_turn_directives"/);
      assert.match(readPromptLastMessageText(prompt), /本轮计划任务目标/);
    } finally {
      await harness.cleanup();
    }
  });

  test("current turn directives append as a text part after multimodal batch content", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        includeBatchMediaCaptions: false,
        batchMessages: [
          createPromptBatchMessage({
            userId: "owner",
            senderName: "Owner",
            text: "看这张图",
            imageVisuals: [{ imageId: "img-1", inputUrl: "data:image/png;base64,AAAA" }]
          })
        ],
        currentTurnDirectives: ["本轮回复目标：先看图再回答"]
      });
      const content = prompt.at(-1)?.content;

      assert.equal(prompt.at(-1)?.role, "user");
      assert.ok(Array.isArray(content));
      assert.equal(content.some((part) => part.type === "image_url"), true);
      const lastPart = content.at(-1);
      assert.equal(lastPart?.type, "text");
      assert.match(lastPart?.type === "text" ? lastPart.text : "", /current_turn_directives/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder does not render task sections without a primary task", async () => {
    const system = await renderTaskPromptSystem({
      version: 1,
      primary: null,
      parked: [],
      evidence: []
    });

    assert.equal(hasPromptSection(system, "task_focus"), false);
    assert.equal(hasPromptSection(system, "active_task_state"), false);
    assert.equal(hasPromptSection(system, "tool_playbooks"), false);
  });

  test("prompt builder renders active task state and tool playbooks", async () => {
    const system = await renderTaskPromptSystem(createTaskTracker("active"), [
      "terminal_run",
      "terminal_start",
      "open_page",
      "inspect_page",
      "ground_with_google_search"
    ], [{
      id: "web_research",
      title: "网页检索与浏览",
      description: "搜索网页、打开页面、交互与截图。",
      toolNames: ["open_page", "inspect_page", "ground_with_google_search"]
    }, {
      id: "shell_runtime",
      title: "Shell 运行时",
      description: "执行与交互 terminal 会话，并复用 terminal resource。",
      toolNames: ["terminal_run", "terminal_start"]
    }]);

    assert.equal(hasPromptSection(system, "task_focus"), true);
    assert.equal(hasPromptSection(system, "active_task_state"), true);
    assert.equal(hasPromptSection(system, "tool_playbooks"), true);
    assert.match(system, /终端操作流程/);
    assert.match(system, /网页检索与浏览流程/);
    assert.match(system, /多步任务执行流程/);
  });

  test("prompt builder renders suspended task as a short inactive hint", async () => {
    const system = await renderTaskPromptSystem(createTaskTracker("suspended"), ["terminal_run"]);
    const state = findPromptSection(system, "active_task_state");

    assert.equal(hasPromptSection(system, "task_focus"), false);
    assert.equal(hasPromptSection(system, "tool_playbooks"), false);
    assert.ok(state);
    assert.match(state.body, /任务已暂停/);
    assert.doesNotMatch(state.body, /已完成=/);
  });

  test("prompt builder does not render completed or canceled task state", async () => {
    const completedSystem = await renderTaskPromptSystem(createTaskTracker("completed"), ["terminal_run"]);
    const canceledSystem = await renderTaskPromptSystem(createTaskTracker("canceled"), ["terminal_run"]);

    assert.equal(hasPromptSection(completedSystem, "task_focus"), false);
    assert.equal(hasPromptSection(completedSystem, "active_task_state"), false);
    assert.equal(hasPromptSection(completedSystem, "tool_playbooks"), false);
    assert.equal(hasPromptSection(canceledSystem, "task_focus"), false);
    assert.equal(hasPromptSection(canceledSystem, "active_task_state"), false);
    assert.equal(hasPromptSection(canceledSystem, "tool_playbooks"), false);
  });

  test("prompt builder keeps ready_to_close task state short", async () => {
    const system = await renderTaskPromptSystem(createTaskTracker("ready_to_close"), ["terminal_run"]);
    const state = findPromptSection(system, "active_task_state");

    assert.equal(hasPromptSection(system, "task_focus"), false);
    assert.equal(hasPromptSection(system, "tool_playbooks"), false);
    assert.ok(state);
    assert.match(state.body, /ready_to_close/);
    assert.doesNotMatch(state.body, /关键工具引用=/);
    assert.doesNotMatch(state.body, /已完成=/);
  });

  test("prompt builder renders parked tasks as one-line summary only", async () => {
    const tracker: SessionTaskTracker = {
      version: 1,
      primary: null,
      parked: [{
        taskId: "parked-1",
        status: "waiting_tool",
        objective: "后台测试",
        summary: "等待终端完成",
        importantToolRefs: [{
          toolCallId: "call-1",
          toolName: "terminal_start",
          summary: "不应展开的工具摘要",
          resource: { kind: "shell_session", id: "term-1" }
        }],
        updatedAtMs: 1
      }],
      evidence: []
    };
    const system = await renderTaskPromptSystem(tracker, ["terminal_run"]);
    const state = findPromptSection(system, "active_task_state");

    assert.equal(hasPromptSection(system, "task_focus"), false);
    assert.equal(hasPromptSection(system, "tool_playbooks"), false);
    assert.ok(state);
    assert.match(state.body, /暂停\/后台任务=waiting_tool:后台测试 等待终端完成/);
    assert.doesNotMatch(state.body, /关键工具引用=/);
    assert.doesNotMatch(state.body, /不应展开的工具摘要/);
  });

  test("prompt builder renders active toolset summary only", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        speakingStyle: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
      });
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        visibleToolNames: ["list_available_toolsets", "request_toolset", "open_page", "inspect_page"],
        activeToolsets: [
          {
            id: "web_research",
            title: "网页检索与浏览",
            description: "搜索网页、打开页面、交互与截图。",
            toolNames: ["open_page", "inspect_page"]
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

      const system = readPromptSystemText(prompt);
      assert.equal(hasPromptSection(system, "toolset_guidance"), true);
      assert.match(system, /当前激活工具集：网页检索与浏览/);
      assert.match(system, /若当前激活工具集不够完成任务，可先查看可申请的工具集，再申请补充。/);
      assert.doesNotMatch(system, /delegate_message_to_chat/);
      assert.doesNotMatch(system, /shell_run/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder renders concise tool hints from visible tools", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        speakingStyle: "直接、简洁，优先把任务做完。"
      });
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        visibleToolNames: [
          "open_page",
          "inspect_page",
          "interact_with_page",
          "asset_list",
          "asset_media_view",
          "asset_media_inspect",
          "asset_send_to_chat",
          "asset_document_overview",
          "asset_document_read",
          "asset_document_search",
          "asset_document_inspect",
          "filesystem_read",
          "filesystem_delete",
          "filesystem_search",
          "filesystem_media_view",
          "filesystem_media_inspect"
        ],
        activeToolsets: [
          {
            id: "web_research",
            title: "网页检索与浏览",
            description: "搜索网页、打开页面、交互与截图。",
            toolNames: ["open_page", "inspect_page", "interact_with_page"]
          },
          {
            id: "asset_io",
            title: "聊天文件",
            description: "查看和发送已登记聊天文件。",
            toolNames: ["asset_list", "asset_media_view", "asset_media_inspect", "asset_send_to_chat"]
          },
          {
            id: "filesystem_io",
            title: "本地文件",
            description: "读取、检索和删除本地文件。",
            toolNames: ["filesystem_read", "filesystem_delete", "filesystem_search", "filesystem_media_view", "filesystem_media_inspect"]
          }
        ],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "整理一下这些资料", timestampMs: Date.now() })]
      });

      const system = readPromptSystemText(prompt);
      assert.equal(hasPromptSection(system, "tool_hints"), true);
      assert.match(system, /页面结构和交互目标用 inspect_page 查看/);
      assert.match(system, /网页检索与浏览流程/);
      assert.match(system, /查已登记图片、视频、音频或文件时先 asset_list/);
      assert.match(system, /处理已登记文档时用 asset_document_overview/);
      assert.match(system, /asset_document_inspect 调文本精读模型/);
      assert.match(system, /需要从图片、截图、表格或界面里精确读取细节时，用图片精读工具按问题查看/);
      assert.doesNotMatch(system, /inspect_media/);
      assert.doesNotMatch(system, /download_asset 返回 workspace file_id/);
      assert.match(system, /filesystem_\* 处理本地文件/);
      assert.doesNotMatch(system, /相对的是配置里的 local files 工作区根目录，绝对路径按进程权限访问/);
      assert.match(system, /filesystem_delete；它支持删除文件或递归删除整个目录/);
      assert.doesNotMatch(system, /需要继续操作浏览器或 shell 时/);
      assert.doesNotMatch(system, /shell_run/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder can split stable and dynamic system messages for cache experiments", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        speakingStyle: "直接、简洁，优先把任务做完。"
      });
      const baseInput = {
        sessionId: "qqbot:p:owner",
        persona,
        relationship: "owner" as const,
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        currentSessionContext: [{
          id: "s1",
          title: "会话事实",
          content: "这个会话正在做缓存测试",
          kind: "fact" as const,
          source: "inferred" as const,
          createdAt: 1,
          updatedAt: 1
        }],
        currentUserMemories: [{
          id: "m1",
          title: "偏好",
          content: "喜欢短答",
          kind: "preference" as const,
          source: "user_explicit" as const,
          createdAt: 1,
          updatedAt: 1
        }],
        historySummary: "用户之前要求关注缓存命中。",
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "整理一下这些资料", timestampMs: Date.now() })]
      };
      const prompt = buildPrompt({
        ...baseInput,
        visibleToolNames: ["list_available_toolsets", "request_toolset", "asset_list", "asset_send_to_chat"],
        activeToolsets: [{
          id: "asset_io",
          title: "聊天文件",
          description: "查看和发送已登记聊天文件。",
          toolNames: ["asset_list", "asset_send_to_chat"]
        }]
      });
      const changedToolPrompt = buildPrompt({
        ...baseInput,
        visibleToolNames: ["open_page", "inspect_page", "filesystem_read"],
        activeToolsets: [{
          id: "web_research",
          title: "网页检索与浏览",
          description: "搜索网页、打开页面、交互与截图。",
          toolNames: ["open_page", "inspect_page"]
        }]
      });

      const stableSystem = String(prompt[0]?.content ?? "");
      const volatileSystem = String(prompt[1]?.content ?? "");
      const capabilitySystem = String(prompt[2]?.content ?? "");
      assert.equal(prompt[0]?.role, "system");
      assert.equal(prompt[1]?.role, "system");
      assert.equal(prompt[2]?.role, "system");
      assert.equal(prompt[3]?.role, "user");
      assert.equal(stableSystem, String(changedToolPrompt[0]?.content ?? ""));
      assert.equal(hasPromptSection(stableSystem, "global_persona"), true);
      assert.equal(hasPromptSection(stableSystem, "reply_rules"), false);
      assert.equal(hasPromptSection(stableSystem, "memory_write_decision"), false);
      assert.equal(hasPromptSection(stableSystem, "tool_hints"), false);
      assert.equal(hasPromptSection(stableSystem, "current_user_memories"), false);
      assert.equal(hasPromptSection(volatileSystem, "reply_rules"), true);
      assert.equal(hasPromptSection(volatileSystem, "memory_write_decision"), true);
      assert.equal(hasPromptSection(volatileSystem, "context_rules"), true);
      assert.equal(hasPromptSection(volatileSystem, "history_summary"), true);
      assert.equal(hasPromptSection(volatileSystem, "current_session_context"), true);
      assert.equal(hasPromptSection(volatileSystem, "current_user_memories"), true);
      assert.equal(hasPromptSection(volatileSystem, "tool_hints"), false);
      assert.equal(hasPromptSection(capabilitySystem, "tool_hints"), true);
      assert.equal(hasPromptSection(capabilitySystem, "toolset_guidance"), true);
      assert.ok(capabilitySystem.indexOf("%%llmbot:section name=\"toolset_guidance\"") > capabilitySystem.indexOf("%%llmbot:section name=\"tool_hints\""));
    } finally {
      await harness.cleanup();
    }
  });

  test("scheduled prompts keep trigger context out of the stable cache prefix", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildScheduledTaskPrompt({
        sessionId: "qqbot:p:owner",
        visibleToolNames: ["list_live_resources", "read_download_resource"],
        activeToolsets: [{
          id: "web_research",
          title: "网页检索与浏览",
          description: "搜索网页、打开页面、交互与截图。",
          toolNames: ["list_live_resources", "read_download_resource"]
        }],
        trigger: {
          kind: "scheduled_instruction",
          jobName: "五分钟提醒",
          taskInstruction: "五分钟后提醒用户去拿外卖。"
        },
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        targetContext: { chatType: "private", userId: "owner", senderName: "Owner" }
      });

      const stableSystem = String(prompt[0]?.content ?? "");
      const volatileSystem = String(prompt[1]?.content ?? "");
      const capabilitySystem = String(prompt[2]?.content ?? "");
      assert.equal(prompt[0]?.role, "system");
      assert.equal(prompt[1]?.role, "system");
      assert.equal(prompt[2]?.role, "system");
      assert.equal(prompt[3]?.role, "user");
      assert.equal(hasPromptSection(stableSystem, "global_persona"), true);
      assert.doesNotMatch(stableSystem, /下面这次执行是内部计划任务/);
      assert.match(volatileSystem, /下面这次执行是内部计划任务/);
      assert.equal(hasPromptSection(volatileSystem, "tool_hints"), false);
      assert.equal(hasPromptSection(capabilitySystem, "tool_hints"), true);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder keeps compact boundary hints for specialized tools", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        speakingStyle: "直接、简洁，优先把任务做完。"
      });
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        visibleToolNames: [
          "download_asset",
          "capture_screenshot",
          "search_accessible_conversations",
          "get_conversation_context",
          "get_scenario_state",
          "update_scenario_state",
          "list_session_modes",
          "switch_session_mode"
        ],
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        historySummary: null,
        recentMessages: [],
        batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "继续处理", timestampMs: Date.now() })]
      });

      const system = readPromptSystemText(prompt);
      assert.match(system, /download_asset\/capture_screenshot 短下载会直接返回 asset_handle/);
      assert.match(system, /长下载会返回 download resource_id/);
      assert.match(system, /只读最小必要范围；不要把其他会话信息混成当前会话事实/);
      assert.match(system, /场景状态工具用于 scenario_host 内部维护/);
      assert.match(system, /先 list_session_modes，再 switch_session_mode/);
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder deduplicates private-context user info and overlapping memory text", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        speakingStyle: "对 owner 像好兄弟一样完全不客气，但会顾及对方的情绪，不再过度毒舌。平时保持直率、可爱且带点“野”的女兄弟风格。"
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

      const system = readPromptSystemText(prompt);
      assert.equal(hasPromptSection(system, "participant_context"), false);
      assert.match(system, /当前长期全局行为规则（最多 4 条）：/);
      assert.match(system, /- 输出规则：先给结论再展开。/);
      assert.doesNotMatch(system, /重复的人设规则/);
      assert.equal(hasPromptSection(system, "current_user_profile"), true);
      assert.equal(hasPromptSection(system, "current_user_memories"), true);
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
        globalTraits: "嘴硬但靠谱的搭档"
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

      const system = readPromptSystemText(prompt);
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
            toolNames: ["dump_debug_literals"]
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

      const normalSystem = readPromptSystemText(normalPrompt);
      const debugSystem = readPromptSystemText(debugPrompt);
      assert.match(normalSystem, /不要承认任何工具存在/);
      assert.match(debugSystem, /当前会话已进入 owner 调试模式/);
      assert.match(debugSystem, /包括工具名、调用原因、调用结果、失败原因、系统约束、后端编排和能力边界/);
      assert.match(debugSystem, /当前激活工具集：调试导出/);
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
      const system = readPromptSystemText(prompt);
      assert.equal(hasPromptSection(system, "history_summary"), false);
      assert.equal(hasPromptSection(system, "participant_context"), false);
      assert.equal(hasPromptSection(system, "toolset_guidance"), false);
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
        temperament: "冷静",
        speakingStyle: "简洁",
        globalTraits: "始终带角色口吻"
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

      const system = readPromptSystemText(prompt);
      const batchText = readPromptLastMessageText(prompt);
      assert.equal(hasPromptSection(system, "global_persona"), true);
      assert.equal(hasPromptSection(system, "memory_write_decision"), false);
      assert.equal(hasPromptSection(system, "global_rules"), false);
      assert.equal(hasPromptSection(system, "current_user_profile"), false);
      assert.equal(hasPromptSection(system, "current_user_memories"), false);
      assert.equal(hasPromptSection(system, "participant_context"), false);
      assert.match(system, /AI assistant 模式工作/);
      assert.deepEqual(findPromptBlock(batchText, "trigger_batch")?.attrs, {
        session: "群聊 123456",
        trigger_user: "Bob (10002)",
        message_count: "1",
        speaker_count: "1"
      });
      assert.deepEqual(parsePromptBlocks(batchText).find((block) => block.tag === "trigger_message")?.attrs, {
        index: "1",
        speaker: "Bob (10002)",
        trigger_user: "yes",
        time: "2026/03/16 17:13:10"
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("prompt builder renders current session context as session-scoped memory", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.get();
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
        currentSessionContext: [{
          id: "session_mem_1",
          title: "会话用途",
          content: "此会话专门用于记忆系统二阶段测试",
          kind: "fact",
          source: "inferred",
          createdAt: 1,
          updatedAt: 1,
          importance: 4
        }],
        historySummary: null,
        recentMessages: [],
        batchMessages: [
          createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "继续", timestampMs: Date.now() })
        ]
      });

      const system = readPromptSystemText(prompt);
      assert.equal(hasPromptSection(system, "current_session_context"), true);
      assert.match(system, /当前会话专属上下文/);
      assert.match(system, /会话用途：此会话专门用于记忆系统二阶段测试/);
    } finally {
      await harness.cleanup();
    }
  });

  test("draft mode uses profile-draft batch framing instead of trigger-user framing", async () => {
    const harness = await createMemoryHarness();
    try {
      const persona = await harness.personaStore.patch({
        name: "Bot",
        temperament: "冷静",
        speakingStyle: "简洁"
      });
      const prompt = buildPrompt({
        sessionId: "qqbot:p:owner",
        modeId: "rp_assistant",
        persona,
        relationship: "owner",
        npcProfiles: [],
        participantProfiles: [],
        userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner", relationship: "owner" }),
        historySummary: null,
        recentMessages: [],
        draftMode: {
          target: "rp",
          phase: "config",
          profile: {
            selfPositioning: "克制",
            socialRole: "",
            lifeContext: "",
            physicalPresence: "",
            realityContract: "",
            continuityFacts: "",
            hardLimits: ""
          },
          missingFields: [
            "socialRole",
            "lifeContext",
            "physicalPresence",
            "realityContract",
            "hardLimits"
          ]
        },
        batchMessages: [
          createPromptBatchMessage({
            userId: "owner",
            senderName: "Owner",
            text: "把现实契约改得更克制一点",
            timestampMs: Date.UTC(2026, 2, 16, 9, 13, 10)
          })
        ]
      });

      const system = readPromptSystemText(prompt);
      const batchText = readPromptLastMessageText(prompt);
      assert.match(system, /当前配置流程处理的是 bot 自身的设定草稿/);
      assert.deepEqual(findPromptBlock(batchText, "draft_batch")?.attrs, {
        session: "私聊 owner",
        message_count: "1",
        speaker_count: "1"
      });
      assert.match(batchText, /默认把 owner 的表述理解为对 bot 当前草稿的描述、修改或补充/);
      assert.deepEqual(findPromptBlock(batchText, "draft_message")?.attrs, {
        index: "1",
        speaker: "Owner (owner)",
        time: "2026/03/16 17:13:10"
      });
      assert.equal(findPromptBlock(batchText, "trigger_batch"), undefined);
      assert.doesNotMatch(batchText, /trigger_user=/);
      assert.doesNotMatch(batchText, /当前触发用户/);
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

      assert.match(String(scenarioPrompt[2]?.content ?? ""), /玩家动作：推开钟楼木门/);
      assert.match(String(scenarioPrompt[3]?.content ?? ""), /场外指令：别推进太快/);
      assert.match(String(scenarioPrompt[4]?.content ?? ""), /玩家对白：里面有人吗/);

      const scenarioBatchText = readPromptLastMessageText(scenarioPrompt);
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

      assert.match(String(normalPrompt[2]?.content ?? ""), /\*推开钟楼木门/);
      assert.doesNotMatch(String(normalPrompt[2]?.content ?? ""), /玩家动作：/);
      const normalBatchText = readPromptLastMessageText(normalPrompt);
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
        harness.userIdentityStore,
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

async function renderTaskPromptSystem(
  taskTracker: SessionTaskTracker,
  visibleToolNames: string[] = [],
  activeToolsets: Parameters<typeof buildPrompt>[0]["activeToolsets"] = []
): Promise<string> {
  const harness = await createMemoryHarness();
  try {
    const persona = await harness.personaStore.patch({
      speakingStyle: "直接、简洁，优先把任务做完。"
    });
    return readPromptSystemText(buildPrompt({
      sessionId: "qqbot:p:owner",
      visibleToolNames,
      activeToolsets,
      taskTracker,
      persona,
      relationship: "owner",
      npcProfiles: [],
      participantProfiles: [],
      userProfile: createPromptUserProfile({ userId: "owner", senderName: "Owner" }),
      historySummary: null,
      recentMessages: [],
      batchMessages: [createPromptBatchMessage({ userId: "owner", senderName: "Owner", text: "继续", timestampMs: 1 })]
    }));
  } finally {
    await harness.cleanup();
  }
}

function createTaskTracker(status: NonNullable<SessionTaskTracker["primary"]>["status"]): SessionTaskTracker {
  return {
    version: 1,
    primary: {
      taskId: "task-1",
      status,
      objective: "实现 TaskTracker prompt 注入",
      originalRequest: "请实现 TaskTracker",
      done: Array.from({ length: 12 }, (_, index) => `done-${index}`),
      next: Array.from({ length: 8 }, (_, index) => `next-${index}`),
      blockers: status === "waiting_user" ? ["等待用户确认"] : [],
      importantToolRefs: [{
        toolCallId: "call-1",
        toolName: "terminal_run",
        summary: "运行测试",
        resource: {
          kind: "shell_session",
          id: "term-1"
        }
      }],
      createdAtMs: 1,
      updatedAtMs: 2,
      ...(status === "ready_to_close" ? { readyToCloseAtMs: 3 } : {})
    },
    parked: [],
    evidence: []
  };
}

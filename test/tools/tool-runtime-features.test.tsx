import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { getBuiltinTools } from "../../src/llm/tools/index.ts";
import { scenarioHostToolHandlers } from "../../src/llm/tools/conversation/scenarioHostTools.ts";
import { sessionToolHandlers } from "../../src/llm/tools/conversation/sessionTools.ts";
import { resourceToolHandlers } from "../../src/llm/tools/runtime/resourceTools.ts";
import { debugToolHandlers } from "../../src/llm/tools/runtime/debugTools.ts";
import { shellToolHandlers } from "../../src/llm/tools/runtime/shellTools.ts";
import { timeToolHandlers } from "../../src/llm/tools/runtime/timeTools.ts";
import { localFileToolHandlers, chatFileToolHandlers } from "../../src/llm/tools/runtime/workspaceTools.ts";
import { setupDraftToolHandlers } from "../../src/llm/tools/conversation/setupDraftTools.ts";
import { profileToolHandlers } from "../../src/llm/tools/profile/profileTools.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

  test("builtin tool list exposes forward, media, and message tools", async () => {
    const config = createForwardFeatureConfig();
    config.search.aliyunIqs.enabled = true;
    config.shell.enabled = true;
    const names = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    assert.ok(names.includes("end_turn_without_reply"));
    assert.ok(names.includes("list_session_modes"));
    assert.ok(names.includes("switch_session_mode"));
    assert.ok(names.includes("get_scenario_state"));
    assert.ok(names.includes("update_scenario_state"));
    assert.ok(names.includes("get_current_time"));
    assert.ok(names.includes("view_forward_record"));
    assert.ok(names.includes("chat_file_view_media"));
    assert.ok(names.includes("view_message"));
    assert.ok(names.includes("chat_file_list"));
    assert.ok(names.includes("chat_file_send_to_chat"));
    assert.ok(names.includes("local_file_send_to_chat"));
    assert.ok(names.includes("ground_with_google_search"));
    assert.ok(names.includes("search_with_iqs_lite_advanced"));
    assert.ok(names.includes("list_live_resources"));
    assert.ok(names.includes("capture_screenshot"));
    assert.ok(names.includes("manage_scheduled_job"));
    assert.ok(names.includes("respond_request"));
    assert.ok(names.includes("set_chat_permission"));
    assert.ok(names.includes("shell_run"));
    assert.ok(names.includes("shell_interact"));
    assert.ok(names.includes("shell_read"));
    assert.ok(names.includes("shell_signal"));
    assert.ok(names.includes("open_page"));
    assert.ok(names.includes("inspect_page"));
    assert.ok(names.includes("interact_with_page"));
    assert.ok(names.includes("close_page"));
  });

  test("builtin tool list hides web tools when search is disabled", async () => {
    const config = createForwardFeatureConfig();
    config.search.googleGrounding.enabled = false;
    config.search.aliyunIqs.enabled = false;
    config.browser.enabled = false;
    config.shell.enabled = false;
    const names = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    assert.ok(!names.includes("ground_with_google_search"));
    assert.ok(!names.includes("search_with_iqs_lite_advanced"));
    assert.ok(!names.includes("list_live_resources"));
    assert.ok(!names.includes("capture_screenshot"));
    assert.ok(!names.includes("shell_run"));
    assert.ok(!names.includes("open_page"));
    assert.ok(!names.includes("inspect_page"));
    assert.ok(!names.includes("interact_with_page"));
    assert.ok(!names.includes("close_page"));
  });

  test("builtin tool list hides external search tools when provider native search is enabled", async () => {
    const config = createForwardFeatureConfig();
    config.search.googleGrounding.enabled = true;
    config.search.aliyunIqs.enabled = true;
    const testProvider = config.llm.providers.test;
    const mainModel = config.llm.models.main;
    assert.ok(testProvider);
    assert.ok(mainModel);
    testProvider.features.search = {
      type: "builtin_tool",
      tool: {
        type: "web_search_preview"
      }
    };
    mainModel.supportsSearch = true;

    const names = getBuiltinTools("owner", config, undefined, {
      modelRef: "main"
    }).map((tool) => tool.function.name);

    assert.ok(!names.includes("ground_with_google_search"));
    assert.ok(!names.includes("search_with_iqs_lite_advanced"));
  });

  test("all object tool schemas expose properties for provider compatibility", async () => {
    const tools = getBuiltinTools("owner", createForwardFeatureConfig());
    for (const tool of tools) {
      const parameters = tool.function.parameters ?? {};
      if (parameters.type === "object") {
        assert.ok(
          Object.prototype.hasOwnProperty.call(parameters, "properties"),
          `tool ${tool.function.name} is missing parameters.properties`
        );
      }
    }
  });

  test("debug-only tools stay hidden unless the current turn is in debug mode", async () => {
    const config = createForwardFeatureConfig();
    assert.ok(!getBuiltinTools("owner", config).map((tool) => tool.function.name).includes("dump_debug_literals"));
    assert.ok(getBuiltinTools("owner", config, undefined, {
      includeDebugTools: true
    }).map((tool) => tool.function.name).includes("dump_debug_literals"));
  });

  test("memory tool descriptions cover category-specific tool surface", async () => {
    const config = createForwardFeatureConfig();
    const tools = getBuiltinTools("owner", config);
    const getPersona = tools.find((tool) => tool.function.name === "get_persona");
    const upsertGlobalRule = tools.find((tool) => tool.function.name === "upsert_global_rule");
    const upsertUserMemory = tools.find((tool) => tool.function.name === "upsert_user_memory");
    assert.match(String(getPersona?.function.description ?? ""), /persona/);
    assert.match(String(upsertGlobalRule?.function.description ?? ""), /全局工作流规则/);
    assert.match(String(upsertUserMemory?.function.description ?? ""), /用户长期记忆/);
  });

  test("memory tools are exposed to both owner and known users", async () => {
    const config = createForwardFeatureConfig();
    const ownerNames = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    const knownNames = getBuiltinTools("known", config).map((tool) => tool.function.name);
    assert.ok(ownerNames.includes("get_persona"));
    assert.ok(ownerNames.includes("patch_persona"));
    assert.ok(ownerNames.includes("upsert_global_rule"));
    assert.ok(ownerNames.includes("upsert_toolset_rule"));
    assert.ok(ownerNames.includes("patch_user_profile"));
    assert.ok(ownerNames.includes("upsert_user_memory"));
    assert.ok(knownNames.includes("get_persona"));
    assert.ok(knownNames.includes("patch_user_profile"));
    assert.ok(knownNames.includes("upsert_user_memory"));
    assert.ok(!knownNames.includes("upsert_global_rule"));
    assert.ok(!knownNames.includes("upsert_toolset_rule"));
  });

  test("normal profile tool scope hides persona and mode profile write tools", async () => {
    const config = createForwardFeatureConfig();
    const names = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "normal"
    }).map((tool) => tool.function.name);
    assert.ok(names.includes("get_persona"));
    assert.ok(!names.includes("patch_persona"));
    assert.ok(!names.includes("clear_persona_field"));
    assert.ok(!names.includes("get_rp_profile"));
    assert.ok(!names.includes("patch_rp_profile"));
    assert.ok(!names.includes("clear_rp_profile_field"));
    assert.ok(!names.includes("get_scenario_profile"));
    assert.ok(!names.includes("patch_scenario_profile"));
    assert.ok(!names.includes("clear_scenario_profile_field"));
  });

  test("persona profile tool scope only exposes persona draft tools", async () => {
    const config = createForwardFeatureConfig();
    const names = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "persona"
    }).map((tool) => tool.function.name);
    assert.ok(names.includes("get_persona"));
    assert.ok(names.includes("patch_persona"));
    assert.ok(names.includes("clear_persona_field"));
    assert.ok(!names.includes("get_rp_profile"));
    assert.ok(!names.includes("patch_rp_profile"));
    assert.ok(!names.includes("get_scenario_profile"));
    assert.ok(!names.includes("patch_scenario_profile"));
  });

  test("rp and scenario profile tool scopes only expose their own draft tools", async () => {
    const config = createForwardFeatureConfig();
    const rpNames = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "rp"
    }).map((tool) => tool.function.name);
    const scenarioNames = getBuiltinTools("owner", config, undefined, {
      profileToolScope: "scenario"
    }).map((tool) => tool.function.name);

    assert.ok(rpNames.includes("get_rp_profile"));
    assert.ok(rpNames.includes("patch_rp_profile"));
    assert.ok(rpNames.includes("clear_rp_profile_field"));
    assert.ok(!rpNames.includes("get_persona"));
    assert.ok(!rpNames.includes("patch_persona"));
    assert.ok(!rpNames.includes("get_scenario_profile"));

    assert.ok(scenarioNames.includes("get_scenario_profile"));
    assert.ok(scenarioNames.includes("patch_scenario_profile"));
    assert.ok(scenarioNames.includes("clear_scenario_profile_field"));
    assert.ok(!scenarioNames.includes("get_persona"));
    assert.ok(!scenarioNames.includes("patch_persona"));
    assert.ok(!scenarioNames.includes("get_rp_profile"));
  });

  test("profile draft handlers read and update operationMode drafts instead of stores", async () => {
    let personaOperationMode = {
      kind: "persona_config" as const,
      draft: {
        ...createEmptyPersona(),
        name: "小满"
      }
    };
    let rpOperationMode = {
      kind: "mode_config" as const,
      modeId: "rp_assistant" as const,
      draft: {
        ...createEmptyRpProfile(),
        premise: "雨夜"
      }
    };

    const personaContext = {
      relationship: "owner",
      lastMessage: {
        sessionId: "web:persona-draft",
        userId: "owner",
        senderName: "Owner"
      },
      sessionManager: {
        getOperationMode() {
          return personaOperationMode;
        },
        setOperationMode(_sessionId: string, operationMode: typeof personaOperationMode) {
          personaOperationMode = operationMode;
          return operationMode;
        }
      }
    } as any;
    const rpContext = {
      relationship: "owner",
      lastMessage: {
        sessionId: "web:rp-draft",
        userId: "owner",
        senderName: "Owner"
      },
      sessionManager: {
        getOperationMode() {
          return rpOperationMode;
        },
        setOperationMode(_sessionId: string, operationMode: typeof rpOperationMode) {
          rpOperationMode = operationMode;
          return operationMode;
        }
      }
    } as any;

    await profileToolHandlers.patch_persona!(
      { id: "tool_persona_draft_patch_1", type: "function", function: { name: "patch_persona", arguments: "{\"personaPatch\":{\"speechStyle\":\"短句\"}}" } },
      { personaPatch: { speechStyle: "短句" } },
      personaContext
    );
    await profileToolHandlers.patch_rp_profile!(
      { id: "tool_rp_draft_patch_1", type: "function", function: { name: "patch_rp_profile", arguments: "{\"profilePatch\":{\"hardRules\":\"绝不跳出角色\"}}" } },
      { profilePatch: { hardRules: "绝不跳出角色" } },
      rpContext
    );

    assert.equal(personaOperationMode.draft.speechStyle, "短句");
    assert.equal(rpOperationMode.draft.hardRules, "绝不跳出角色");
    assert.equal(JSON.parse(String(await profileToolHandlers.get_persona!(
      { id: "tool_persona_draft_get_1", type: "function", function: { name: "get_persona", arguments: "{}" } },
      {},
      personaContext
    ))).speechStyle, "短句");
    assert.equal(JSON.parse(String(await profileToolHandlers.get_rp_profile!(
      { id: "tool_rp_draft_get_1", type: "function", function: { name: "get_rp_profile", arguments: "{}" } },
      {},
      rpContext
    ))).hardRules, "绝不跳出角色");
  });

  test("send_setup_draft uses committed text sink for web sessions", async () => {
    const appended: string[] = [];
    const historyCalls: Array<{ sessionId: string; message: Record<string, unknown> }> = [];

    const result = await setupDraftToolHandlers.send_setup_draft!(
      { id: "tool_setup_draft_web_1", type: "function", function: { name: "send_setup_draft", arguments: "{\"content\":\"当前草稿：名字=小满\"}" } },
      { content: "当前草稿：名字=小满" },
      {
        replyDelivery: "web",
        lastMessage: {
          sessionId: "web:persona-draft",
          userId: "owner",
          senderName: "Owner"
        },
        committedTextSink: {
          commitText(chunk: string) {
            appended.push(chunk);
          }
        },
        oneBotClient: {
          async sendText() {
            throw new Error("web draft should not use onebot sendText");
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> | void }) {
            void params.send();
          }
        },
        sessionManager: {
          getSession() {
            return { type: "private" };
          },
          appendAssistantHistory(sessionId: string, message: Record<string, unknown>) {
            historyCalls.push({ sessionId, message });
          }
        }
      } as any
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(JSON.parse(String(result)), { ok: true, queued: true, sent: true });
    assert.deepEqual(appended, ["当前草稿：名字=小满"]);
    assert.deepEqual(historyCalls, [{
      sessionId: "web:persona-draft",
      message: {
        chatType: "private",
        userId: "owner",
        senderName: "Owner",
        text: "当前草稿：名字=小满"
      }
    }]);
  });

  test("send_setup_draft keeps onebot delivery and records sent history for chat sessions", async () => {
    const sentTargets: Array<{ userId?: string; groupId?: string; text: string }> = [];
    const sentMessages: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
    const historyCalls: Array<{ sessionId: string; message: Record<string, unknown> }> = [];

    const result = await setupDraftToolHandlers.send_setup_draft!(
      { id: "tool_setup_draft_onebot_1", type: "function", function: { name: "send_setup_draft", arguments: "{\"content\":\"当前 RP 草稿：前提=雨夜\"}" } },
      { content: "当前 RP 草稿：前提=雨夜" },
      {
        replyDelivery: "onebot",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "owner",
          senderName: "Owner"
        },
        oneBotClient: {
          async sendText(target: { userId?: string; groupId?: string; text: string }) {
            sentTargets.push(target);
            return {
              data: {
                message_id: 12345
              }
            };
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> | void }) {
            void params.send();
          }
        },
        sessionManager: {
          getSession() {
            return { type: "private" };
          },
          recordSentMessage(sessionId: string, message: Record<string, unknown>) {
            sentMessages.push({ sessionId, message });
          },
          appendAssistantHistory(sessionId: string, message: Record<string, unknown>) {
            historyCalls.push({ sessionId, message });
          }
        }
      } as any
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(JSON.parse(String(result)), { ok: true, queued: true, sent: true });
    assert.deepEqual(sentTargets, [{
      userId: "10001",
      text: "当前 RP 草稿：前提=雨夜"
    }]);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.sessionId, "qqbot:p:10001");
    assert.equal(sentMessages[0]?.message.messageId, 12345);
    assert.equal(sentMessages[0]?.message.text, "当前 RP 草稿：前提=雨夜");
    assert.equal(typeof sentMessages[0]?.message.sentAt, "number");
    assert.deepEqual(historyCalls, [{
      sessionId: "qqbot:p:10001",
      message: {
        chatType: "private",
        userId: "owner",
        senderName: "Owner",
        text: "当前 RP 草稿：前提=雨夜",
        deliveryRef: {
          platform: "onebot",
          messageId: 12345
        }
      }
    }]);
  });

  test("old polymorphic memory tools are no longer exposed", async () => {
    const config = createForwardFeatureConfig();
    const toolNames = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    assert.ok(!toolNames.includes("read_memory"));
    assert.ok(!toolNames.includes("write_memory"));
    assert.ok(!toolNames.includes("remove_memory"));
  });

  test("global rule handlers allow owner and reject non-owner", async () => {
    const ownerResult = await profileToolHandlers.upsert_global_rule!(
      { id: "tool_global_rule_1", type: "function", function: { name: "upsert_global_rule", arguments: "{\"title\":\"输出顺序\",\"content\":\"先结论后细节\"}" } },
      { title: "输出顺序", content: "先结论后细节" },
      {
        relationship: "owner",
        globalRuleStore: {
          async upsert(input: { title: string; content: string }) {
            return { action: "created", item: { id: "rule_1", updatedAt: 1, createdAt: 1, kind: "workflow", source: "owner_explicit", ...input }, rules: [] };
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(ownerResult)).rule.title, "输出顺序");

    const deniedResult = await profileToolHandlers.upsert_global_rule!(
      { id: "tool_global_rule_2", type: "function", function: { name: "upsert_global_rule", arguments: "{\"title\":\"输出顺序\",\"content\":\"先结论后细节\"}" } },
      { title: "输出顺序", content: "先结论后细节" },
      {
        relationship: "known",
        globalRuleStore: {}
      } as any
    );
    assert.match(String(deniedResult), /Only owner can edit global rules/);
  });

  test("memory handlers surface structured scope conflict warnings", async () => {
    const personaWarningResult = await profileToolHandlers.patch_persona!(
      { id: "tool_persona_warn_1", type: "function", function: { name: "patch_persona", arguments: "{\"personaPatch\":{\"speechStyle\":\"所有任务默认先给结论再展开\"}}" } },
      { personaPatch: { speechStyle: "所有任务默认先给结论再展开" } },
      {
        relationship: "owner",
        personaStore: {
          isComplete() {
            return false;
          },
          async patchWithDiagnostics() {
            return {
              persona: {
                name: "",
                coreIdentity: "",
                personality: "",
                interests: "",
                background: "",
                speechStyle: "所有任务默认先给结论再展开"
              },
              warning: {
                code: "warning_scope_conflict",
                currentScope: "persona",
                suggestedScope: "global_rules",
                reason: "内容更像跨任务长期工作流规则，不像 bot 身份、人设、口吻或角色边界。"
              }
            };
          }
        },
        setupStore: {
          async advanceAfterPersonaUpdate() {
            return undefined;
          }
        },
        globalProfileReadinessStore: {
          async setPersonaReadiness() {
            return null;
          }
        }
      } as any
    );
    const personaPayload = JSON.parse(String(personaWarningResult));
    assert.equal(personaPayload.finalAction, "warning_scope_conflict");
    assert.equal(personaPayload.warnings[0].suggestedScope, "global_rules");

    const globalWarningResult = await profileToolHandlers.upsert_global_rule!(
      { id: "tool_global_rule_warn_1", type: "function", function: { name: "upsert_global_rule", arguments: "{\"title\":\"角色口吻\",\"content\":\"以后都用傲娇少女口吻说话\"}" } },
      { title: "角色口吻", content: "以后都用傲娇少女口吻说话" },
      {
        relationship: "owner",
        globalRuleStore: {
          async upsert(input: { title: string; content: string }) {
            return {
              action: "created",
              finalAction: "warning_scope_conflict",
              dedup: { matchedBy: "none", matchedExistingId: null },
              warning: {
                code: "warning_scope_conflict",
                currentScope: "global_rules",
                suggestedScope: "persona",
                reason: "内容更像 bot 身份、人设、口吻或角色边界，而不是 owner 级通用工作流规则。"
              },
              item: { id: "rule_warn_1", updatedAt: 1, createdAt: 1, kind: "workflow", source: "owner_explicit", ...input },
              rules: []
            };
          }
        }
      } as any
    );
    const globalPayload = JSON.parse(String(globalWarningResult));
    assert.equal(globalPayload.finalAction, "warning_scope_conflict");
    assert.equal(globalPayload.warnings[0].suggestedScope, "persona");
    assert.equal(globalPayload.reroute.result, "not_rerouted_scope_warning");
    assert.equal(globalPayload.reroute.suggestedScope, "persona");

    const userWarningResult = await profileToolHandlers.upsert_user_memory!(
      { id: "tool_user_memory_warn_1", type: "function", function: { name: "upsert_user_memory", arguments: "{\"title\":\"叫我\",\"content\":\"以后叫我老王\"}" } },
      { title: "叫我", content: "以后叫我老王" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        userStore: {
          async upsertMemory(input: { title: string; content: string }) {
            return {
              action: "created",
              finalAction: "warning_scope_conflict",
              dedup: { matchedBy: "none", matchedExistingId: null },
              warning: {
                code: "warning_scope_conflict",
                currentScope: "user_memories",
                suggestedScope: "user_profile",
                reason: "内容更像结构化用户卡片字段，适合写入 user profile。"
              },
              item: { id: "mem_warn_1", updatedAt: 1, createdAt: 1, kind: "other", source: "user_explicit", ...input },
              user: null
            };
          }
        }
      } as any
    );
    const userPayload = JSON.parse(String(userWarningResult));
    assert.equal(userPayload.finalAction, "warning_scope_conflict");
    assert.equal(userPayload.warnings[0].suggestedScope, "user_profile");
    assert.equal(userPayload.reroute.result, "not_rerouted_scope_warning");
    assert.equal(userPayload.reroute.suggestedScope, "user_profile");
  });

  test("profile handlers preserve structured fields and user-memory handlers keep durable preferences in user memories", async () => {
    const profileResult = await profileToolHandlers.patch_user_profile!(
      { id: "tool_profile_patch_1", type: "function", function: { name: "patch_user_profile", arguments: "{\"timezone\":\"Asia/Shanghai\",\"occupation\":\"产品经理\",\"profileSummary\":\"做事很快\\n经常先给结论\"}" } },
      { timezone: "Asia/Shanghai", occupation: "产品经理", profileSummary: "做事很快\n经常先给结论" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        userStore: {
          async patchUserProfile() {
            return {
              userId: "10001",
              relationship: "known",
              timezone: "Asia/Shanghai",
              occupation: "产品经理",
              profileSummary: "做事很快；经常先给结论",
              memories: [],
              createdAt: 1
            };
          }
        }
      } as any
    );
    const profilePayload = JSON.parse(String(profileResult));
    assert.equal(profilePayload.targetCategory, "user_profile");
    assert.equal(profilePayload.profile.timezone, "Asia/Shanghai");
    assert.equal(profilePayload.profile.occupation, "产品经理");

    const userMemoryResult = await profileToolHandlers.upsert_user_memory!(
      { id: "tool_user_memory_boundary_1", type: "function", function: { name: "upsert_user_memory", arguments: "{\"title\":\"交流边界\",\"content\":\"不要替我做决定\"}" } },
      { title: "交流边界", content: "不要替我做决定" },
      {
        relationship: "known",
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "10001",
          senderName: "Tester"
        },
        userStore: {
          async upsertMemory(input: { title: string; content: string }) {
            return {
              action: "created",
              finalAction: "created",
              dedup: { matchedBy: "none", matchedExistingId: null },
              warning: null,
              item: { id: "mem_boundary_1", updatedAt: 1, createdAt: 1, kind: "boundary", source: "user_explicit", ...input },
              user: null
            };
          }
        }
      } as any
    );
    const userMemoryPayload = JSON.parse(String(userMemoryResult));
    assert.equal(userMemoryPayload.targetCategory, "user_memories");
    assert.equal(userMemoryPayload.finalAction, "created");
    assert.equal(userMemoryPayload.memory.kind, "boundary");
    assert.equal(userMemoryPayload.reroute.result, "not_applicable");
  });

  test("toolset rule handlers upsert duplicates into existing rules", async () => {
    const existing = [{
      id: "rule_1",
      title: "网页登录处理",
      content: "只有在明确遇到登录任务时，才读取并使用站点凭据。",
      toolsetIds: ["web_research"],
      source: "owner_explicit",
      createdAt: 1,
      updatedAt: 1
    }];
    const duplicateResult = await profileToolHandlers.upsert_toolset_rule!(
      { id: "tool_toolset_rule_1", type: "function", function: { name: "upsert_toolset_rule", arguments: "{\"title\":\"网页登录规则\",\"content\":\"只有在明确遇到登录任务时，才读取并使用站点凭据。\",\"toolset_ids\":[\"web_research\"]}" } },
      { title: "网页登录规则", content: "只有在明确遇到登录任务时，才读取并使用站点凭据。", toolset_ids: ["web_research"] },
      {
        relationship: "owner",
        toolsetRuleStore: {
          async upsert() {
            return {
              action: "updated_existing",
              dedup: {
                matchedBy: "near_duplicate",
                matchedExistingId: "rule_1",
                similarityScore: 0.88
              },
              item: existing[0],
              rules: existing
            };
          }
        }
      } as any
    );
    const duplicatePayload = JSON.parse(String(duplicateResult));
    assert.equal(duplicatePayload.action, "updated_existing");
    assert.equal(duplicatePayload.dedup.similarityScore, 0.88);

    const updateResult = await profileToolHandlers.upsert_toolset_rule!(
      { id: "tool_toolset_rule_2", type: "function", function: { name: "upsert_toolset_rule", arguments: "{\"ruleId\":\"rule_1\",\"title\":\"网页登录处理\",\"content\":\"遇到明确登录任务时才读取并使用站点凭据。\",\"toolset_ids\":[\"web_research\"]}" } },
      { ruleId: "rule_1", title: "网页登录处理", content: "遇到明确登录任务时才读取并使用站点凭据。", toolset_ids: ["web_research"] },
      {
        relationship: "owner",
        toolsetRuleStore: {
          async upsert(input: { ruleId?: string; title: string; content: string; toolsetIds: string[] }) {
            return {
              action: "updated_existing",
              item: {
                id: input.ruleId ?? "rule_1",
                title: input.title,
                content: input.content,
                toolsetIds: input.toolsetIds,
                source: "owner_explicit",
                createdAt: 1,
                updatedAt: 2
              },
              rules: []
            };
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(updateResult)).rule.id, "rule_1");
  });

  test("scheduler tool description emphasizes future triggers and self-contained instructions", async () => {
    const config = createForwardFeatureConfig();
    const tools = getBuiltinTools("owner", config);
    const createJob = tools.find((tool) => tool.function.name === "create_scheduled_job");
    assert.match(String(createJob?.function.description ?? ""), /未来某时提醒、延后处理或定期执行/);
    assert.match(String(createJob?.function.description ?? ""), /触发当时可直接执行的完整任务/);
    assert.match(String(createJob?.function.description ?? ""), /查资料、看图或调用其他工具/);
  });

  test("end_turn_without_reply requests a terminal empty response", async () => {
    const result = await sessionToolHandlers.end_turn_without_reply!(
      { id: "tool_end_turn_1", type: "function", function: { name: "end_turn_without_reply", arguments: "{\"reason\":\"明确收尾\"}" } },
      { reason: "明确收尾" },
      {} as any
    );

    assert.equal(typeof result, "object");
    assert.equal(JSON.parse(String((result as any).content)).ended, true);
    assert.equal((result as any).terminalResponse?.text, "");
  });

  test("session mode tools expose available modes and can switch to scenario_host in private chats", async () => {
    const listed = await sessionToolHandlers.list_session_modes!(
      { id: "tool_mode_list_1", type: "function", function: { name: "list_session_modes", arguments: "{}" } },
      {},
      {
        lastMessage: {
          sessionId: "qqbot:p:owner",
          userId: "owner",
          senderName: "Owner"
        },
        listSessionModes: () => [{
          id: "rp_assistant",
          title: "RP Assistant",
          description: "当前默认模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "assistant",
          title: "Assistant",
          description: "普通助手模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "scenario_host",
          title: "Scenario Host",
          description: "私聊剧情主持。",
          allowedChatTypes: ["private"]
        }],
        sessionManager: {
          getModeId() {
            return "rp_assistant";
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(listed)).currentModeId, "rp_assistant");

    const listedPayload = JSON.parse(String(listed));
    assert.equal(listedPayload.currentModeId, "rp_assistant");
    assert.equal(listedPayload.modes[1].id, "assistant");
    assert.equal(listedPayload.modes[2].id, "scenario_host");

    const switched = await sessionToolHandlers.switch_session_mode!(
      { id: "tool_mode_switch_1", type: "function", function: { name: "switch_session_mode", arguments: "{\"modeId\":\"scenario_host\"}" } },
      { modeId: "scenario_host" },
      {
        lastMessage: {
          sessionId: "qqbot:p:owner",
          userId: "owner",
          senderName: "Owner"
        },
        listSessionModes: () => [{
          id: "rp_assistant",
          title: "RP Assistant",
          description: "当前默认模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "assistant",
          title: "Assistant",
          description: "普通助手模式。",
          allowedChatTypes: ["private", "group"]
        }, {
          id: "scenario_host",
          title: "Scenario Host",
          description: "私聊剧情主持。",
          allowedChatTypes: ["private"]
        }],
        sessionManager: {
          getSession() {
            return {
              id: "qqbot:p:owner",
              type: "private",
              participantUserId: "owner",
              participantLabel: "Owner"
            };
          },
          getModeId() {
            return "rp_assistant";
          },
          setModeId() {
            return true;
          }
        },
        scenarioHostStateStore: {
          async ensureForSession() {
            return {};
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(switched)).toModeId, "scenario_host");
  });

  test("session mode tools reject scenario_host in group chats", async () => {
    const switched = await sessionToolHandlers.switch_session_mode!(
      { id: "tool_mode_switch_group_1", type: "function", function: { name: "switch_session_mode", arguments: "{\"modeId\":\"scenario_host\"}" } },
      { modeId: "scenario_host" },
      {
        lastMessage: {
          sessionId: "qqbot:g:1000",
          userId: "owner",
          senderName: "Owner"
        },
        sessionManager: {
          getSession() {
            return {
              id: "qqbot:g:1000",
              type: "group"
            };
          },
          getModeId() {
            return "rp_assistant";
          }
        }
      } as any
    );
    assert.match(String(switched), /does not support group chat/);
  });

  test("scenario_host tools read and update structured session state", async () => {
    let state = {
      version: 1 as const,
      currentSituation: "旧局势",
      currentLocation: null as string | null,
      sceneSummary: "",
      player: { userId: "owner", displayName: "Owner" },
      inventory: [] as Array<{ ownerId: string; item: string; quantity: number }>,
      objectives: [] as Array<{ id: string; title: string; status: "active" | "completed" | "failed"; summary: string }>,
      worldFacts: [] as string[],
      flags: {} as Record<string, string | number | boolean>,
      turnIndex: 0
    };
    const context = {
      lastMessage: {
        sessionId: "qqbot:p:owner",
        userId: "owner",
        senderName: "Owner"
      },
      sessionManager: {
        getModeId() {
          return "scenario_host";
        },
        getSession() {
          return {
            id: "qqbot:p:owner",
            participantUserId: "owner",
            participantLabel: "Owner"
          };
        }
      },
      scenarioHostStateStore: {
        async ensure() {
          return state;
        },
        async update(_sessionId: string, updater: (current: typeof state) => typeof state) {
          state = updater(state);
          return state;
        }
      },
      persistSession() {}
    } as any;

    const initial = await scenarioHostToolHandlers.get_scenario_state!(
      { id: "tool_scenario_get_1", type: "function", function: { name: "get_scenario_state", arguments: "{}" } },
      {},
      context
    );
    assert.ok(!("title" in JSON.parse(String(initial))));

    const updated = await scenarioHostToolHandlers.update_scenario_state!(
      { id: "tool_scenario_update_1", type: "function", function: { name: "update_scenario_state", arguments: "{\"title\":\"钟楼迷雾\",\"currentSituation\":\"玩家来到门前\",\"turnIndex\":2}" } },
      { title: "钟楼迷雾", currentSituation: "玩家来到门前", turnIndex: 2 },
      context
    );
    const updatedState = JSON.parse(String(updated));
    assert.equal(updatedState.turnIndex, 2);
    assert.equal(updatedState.currentSituation, "玩家来到门前");
    assert.ok(!("title" in updatedState));

    const worldFact = await scenarioHostToolHandlers.append_world_fact!(
      { id: "tool_scenario_fact_1", type: "function", function: { name: "append_world_fact", arguments: "{\"fact\":\"钟楼每隔一刻钟响一次\"}" } },
      { fact: "钟楼每隔一刻钟响一次" },
      context
    );
    assert.equal(JSON.parse(String(worldFact)).worldFacts[0], "钟楼每隔一刻钟响一次");
  });

  test("update_scenario_state ignores initialized field (only .confirm can set it)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tool-scenario-"));
    try {
      const { ScenarioHostStateStore } = await import("../../src/modes/scenarioHost/stateStore.ts");
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      const sessionId = "qqbot:p:u1";

      const handler = scenarioHostToolHandlers["update_scenario_state"];
      assert.ok(handler, "update_scenario_state handler must exist");

      // Initialize state first
      await store.ensure(sessionId, { playerUserId: "u1", playerDisplayName: "Alice" });

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

      // Call with title only — it should be ignored and leave the state unchanged
      const result = await handler(
        { id: "tc1", function: { name: "update_scenario_state", arguments: "" } } as any,
        { title: "神秘城堡" },
        context
      );

      const parsed = JSON.parse(result as string);
      assert.equal(parsed.initialized, false, "initialized should remain false — only .confirm can set it");
      assert.ok(!("title" in parsed));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("get_current_time returns configured timezone and precise clock values", async () => {
    const result = await timeToolHandlers.get_current_time!(
      { id: "tool_time_1", type: "function", function: { name: "get_current_time", arguments: "{}" } },
      {},
      {
        config: createForwardFeatureConfig(),
        relationship: "owner",
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        currentUser: null,
        oneBotClient: {},
        requestStore: {},
        sessionManager: {},
        whitelistStore: {},
        scheduledJobStore: {},
        scheduler: {},
        shellRuntime: {},
        shellSessionRuntime: {},
        commandRuntime: {},
        tmuxRuntime: {},
        tmuxSessionStore: {},
        searchService: {},
        chatFileStore: {},
        mediaVisionService: {},
        mediaCaptionService: {},
        forwardResolver: {},
        userStore: {},
        personaStore: {},
        setupStore: {},
        conversationAccess: {},
        npcDirectory: {}
      } as any
    );
    const payload = JSON.parse(String(result));
    assert.equal(payload.timezone, "Asia/Shanghai");
    assert.match(payload.isoUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(payload.localTime, /^\d{4}\/\d{2}\/\d{2}/);
    assert.equal(typeof payload.nowMs, "number");
    assert.equal(typeof payload.weekday, "string");
  });

  test("shell_run forwards resource description", async () => {
    const result = await shellToolHandlers.shell_run!(
      { id: "tool_shell_run_1", type: "function", function: { name: "shell_run", arguments: "{\"command\":\"pwd\",\"description\":\"确认当前目录\"}" } },
      { command: "pwd", description: "确认当前目录" },
      {
        relationship: "owner",
        shellRuntime: {
          async run(input: any) {
            assert.equal(input.command, "pwd");
            assert.equal(input.description, "确认当前目录");
            return {
              output: "/tmp\n",
              status: "completed",
              exitCode: 0,
              signal: null
            };
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.status, "completed");
  });

  test("list_live_resources supports shell-only filtering", async () => {
    const result = await resourceToolHandlers.list_live_resources!(
      { id: "tool_shell_list_1", type: "function", function: { name: "list_live_resources", arguments: "{\"type\":\"shell\"}" } },
      { type: "shell" },
      {
        config: createForwardFeatureConfig(),
        shellRuntime: {
          async listSessionResources() {
            return [{
              resource_id: "res_shell_1",
              status: "active",
              command: "pwd",
              cwd: "/tmp",
              shell: "/bin/sh",
              login: true,
              tty: true,
              title: "pwd @ /tmp",
              description: "查看当前工作目录",
              summary: "pwd (cwd=/tmp)",
              createdAtMs: 1,
              lastAccessedAtMs: 2,
              expiresAtMs: null
            }];
          }
        },
        browserService: {
          async listPages() {
            throw new Error("should not list browser pages when type=shell");
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.type, "shell");
    assert.equal(payload.live_resources[0].resource_id, "res_shell_1");
  });

  test("dump_debug_literals pushes one literal per outbound message without writing history", async () => {
    const sentMetaCalls: any[] = [];
    const sentMessages: any[] = [];
    const result = await debugToolHandlers.dump_debug_literals!(
      { id: "tool_debug_dump_1", type: "function", function: { name: "dump_debug_literals", arguments: "{\"literals\":[\"full_system_prompt\",\"persona\"]}" } },
      { literals: ["full_system_prompt", "persona"] },
      {
        relationship: "owner",
        replyDelivery: "onebot",
        lastMessage: { sessionId: "qqbot:p:2254600711", userId: "owner", senderName: "Owner" },
        debugSnapshot: {
          sessionId: "qqbot:p:2254600711",
          systemMessages: ["system prompt"],
          visibleToolNames: [],
          activeToolsets: [],
          historySummary: null,
          recentHistory: [],
          currentBatch: [],
          liveResources: [],
          recentToolEvents: [],
          debugMarkers: [],
          toolTranscript: [],
          persona: { name: "Test Persona" },
          globalRules: [],
          toolsetRules: [],
          currentUser: null,
          participantProfiles: [],
          imageCaptions: [],
          lastLlmUsage: null
        },
        oneBotClient: {
          async sendText(params: { userId?: string; groupId?: string; text: string }) {
            sentMessages.push(params);
            return { status: "ok", retcode: 0, data: { message_id: sentMessages.length } };
          }
        },
        sessionManager: {
          recordSentMessage(_sessionId: string, message: unknown) {
            sentMetaCalls.push({ kind: "sent", message });
          },
          appendDebugMarker(_sessionId: string, marker: unknown) {
            sentMetaCalls.push({ kind: "marker", marker });
          },
          getDebugMarkers() {
            return [];
          },
          getSessionView() {
            return { lastLlmUsage: null, internalTranscript: [] };
          }
        },
        personaStore: {
          async get() {
            return { name: "Test Persona" };
          }
        }
      } as any
    );

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[0], { userId: "2254600711", text: "system prompt" });
    assert.match(sentMessages[1].text, /Test Persona/);
    assert.equal(sentMetaCalls.length, 3);
    assert.equal(sentMetaCalls[2].kind, "marker");
    assert.equal((result as any).terminalResponse?.text, "");
  });

  test("chat_file_send_to_chat rejects text when sending an image", async () => {
    const result = await chatFileToolHandlers.chat_file_send_to_chat!(
      { id: "tool_workspace_send_text_reject", type: "function", function: { name: "chat_file_send_to_chat", arguments: "{\"file_id\":\"file_img_1\",\"text\":\"发你了\"}" } },
      { file_ref: "img_deadbeef.png", text: "发你了" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "img_deadbeef.png" && id !== "file_img_1") {
              return null;
            }
            return {
              fileId: "file_img_1",
              fileRef: "img_deadbeef.png",
              kind: "image",
              sourceName: "test.png",
              chatFilePath: "workspace/media/file_img_1.png"
            };
          },
          async listFiles() {
            return [];
          }
        }
      } as any
    );

    assert.deepEqual(JSON.parse(String(result)), {
      error: "chat_file_send_to_chat 发送图片时不能附带 text"
    });
  });

  test("chat_file_send_to_chat sends a pure image and keeps the turn open", async () => {
    const sentMessages: any[] = [];
    const sentMetaCalls: any[] = [];
    const transcriptCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-"));
    const imagePath = join(tempDir, "test.png");
    const imageBytes = Buffer.from("fake-image-bytes");
    await writeFile(imagePath, imageBytes);

    try {
    const result = await chatFileToolHandlers.chat_file_send_to_chat!(
      { id: "tool_workspace_send_1", type: "function", function: { name: "chat_file_send_to_chat", arguments: "{\"file_ref\":\"img_deadbeef.png\"}" } },
      { file_ref: "img_deadbeef.png" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "img_deadbeef.png" && id !== "file_img_1") {
              return null;
            }
            return {
              fileId: "file_img_1",
              fileRef: "img_deadbeef.png",
              kind: "image",
              sourceName: "test.png",
              chatFilePath: "workspace/media/file_img_1.png"
            };
          },
          async listFiles() {
            return [];
          },
          async resolveAbsolutePath() {
            return imagePath;
          }
        },
        oneBotClient: {
          async sendMessage(params: unknown) {
            sentMessages.push(params);
            return { status: "ok", retcode: 0, data: { message_id: 42 } };
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> }) {
            queuedTasks.push(params.send);
          }
        },
        sessionManager: {
          recordSentMessage(_sessionId: string, message: unknown) {
            sentMetaCalls.push(message);
          },
          appendInternalTranscript(_sessionId: string, item: unknown) {
            transcriptCalls.push(item);
          }
        }
      } as any
    );

    assert.equal(queuedTasks.length, 1);
    assert.equal(sentMessages.length, 0);
    assert.equal(sentMetaCalls.length, 0);
    assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
      ok: true,
      file_ref: "img_deadbeef.png",
      file_id: "file_img_1",
      deliveredAs: "image",
      queued: true
    });

    await queuedTasks[0]!();

    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0], {
      userId: "owner",
      message: [
        { type: "image", data: { file: `base64://${imageBytes.toString("base64")}` } }
      ]
    });
    assert.deepEqual(sentMetaCalls[0], {
      messageId: 42,
      text: "img_deadbeef.png",
      sentAt: sentMetaCalls[0].sentAt
    });
    assert.deepEqual(transcriptCalls[0], {
      kind: "outbound_media_message",
      llmVisible: false,
      role: "assistant",
      delivery: "onebot",
      mediaKind: "image",
      fileId: "file_img_1",
      fileRef: "img_deadbeef.png",
      sourceName: "test.png",
      chatFilePath: "workspace/media/file_img_1.png",
      sourcePath: null,
      messageId: 42,
      toolName: "chat_file_send_to_chat",
      captionText: null,
      timestampMs: transcriptCalls[0].timestampMs
    });
    assert.equal(typeof transcriptCalls[0].timestampMs, "number");
    assert.equal(typeof sentMetaCalls[0].sentAt, "number");
    assert.equal((result as any).terminalResponse, undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("chat_file_send_to_chat keeps the turn open for non-image fallback sends", async () => {
    const sentTexts: any[] = [];
    const sentMetaCalls: any[] = [];
    const assistantHistoryCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const result = await chatFileToolHandlers.chat_file_send_to_chat!(
      { id: "tool_workspace_send_2", type: "function", function: { name: "chat_file_send_to_chat", arguments: "{\"file_ref\":\"file_bead1234.txt\"}" } },
      { file_ref: "file_bead1234.txt" },
      {
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "file_bead1234.txt" && id !== "file_file_1") {
              return null;
            }
            return {
              fileId: "file_file_1",
              fileRef: "file_bead1234.txt",
              kind: "file",
              sourceName: "note.txt",
              chatFilePath: "workspace/media/file_file_1.txt"
            };
          },
          async listFiles() {
            return [];
          }
        },
        oneBotClient: {
          async sendText(params: unknown) {
            sentTexts.push(params);
            return { status: "ok", retcode: 0, data: { message_id: 43 } };
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> }) {
            queuedTasks.push(params.send);
          }
        },
        sessionManager: {
          recordSentMessage(_sessionId: string, message: unknown) {
            sentMetaCalls.push(message);
          },
          appendAssistantHistory(_sessionId: string, message: unknown) {
            assistantHistoryCalls.push(message);
          }
        }
      } as any
    );

    assert.equal(queuedTasks.length, 1);
    assert.equal(sentTexts.length, 0);
    assert.equal(sentMetaCalls.length, 0);
    assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
      ok: true,
      file_ref: "file_bead1234.txt",
      file_id: "file_file_1",
      deliveredAs: "text_fallback",
      queued: true
    });

    await queuedTasks[0]!();

    assert.equal(sentTexts.length, 1);
    assert.deepEqual(sentTexts[0], {
      userId: "owner",
      text: "chat file 已发送：file_bead1234.txt；file_id=file_file_1"
    });
    assert.deepEqual(sentMetaCalls[0], {
      messageId: 43,
      text: "chat file 已发送：file_bead1234.txt；file_id=file_file_1",
      sentAt: sentMetaCalls[0].sentAt
    });
    assert.deepEqual(assistantHistoryCalls[0], {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "chat file 已发送：file_bead1234.txt；file_id=file_file_1",
      deliveryRef: {
        platform: "onebot",
        messageId: 43
      }
    });
    assert.equal(typeof sentMetaCalls[0].sentAt, "number");
    assert.equal((result as any).terminalResponse, undefined);
  });

  test("chat_file_send_to_chat mirrors non-image fallback text into web delivery", async () => {
    const webChunks: string[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const assistantHistoryCalls: any[] = [];

    const result = await chatFileToolHandlers.chat_file_send_to_chat!(
      { id: "tool_workspace_send_2_web", type: "function", function: { name: "chat_file_send_to_chat", arguments: "{\"file_ref\":\"file_bead1234.txt\"}" } },
      { file_ref: "file_bead1234.txt" },
      {
        replyDelivery: "web",
        committedTextSink: {
          commitText(chunk: string) {
            webChunks.push(chunk);
          }
        },
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        chatFileStore: {
          async getFile(id: string) {
            if (id !== "file_bead1234.txt" && id !== "file_file_1") {
              return null;
            }
            return {
              fileId: "file_file_1",
              fileRef: "file_bead1234.txt",
              kind: "file",
              sourceName: "note.txt",
              chatFilePath: "workspace/media/file_file_1.txt"
            };
          },
          async listFiles() {
            return [];
          }
        },
        messageQueue: {
          enqueueTextDetached(params: { send: () => Promise<void> }) {
            queuedTasks.push(params.send);
          }
        },
        sessionManager: {
          appendAssistantHistory(_sessionId: string, message: unknown) {
            assistantHistoryCalls.push(message);
          }
        }
      } as any
    );

    assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
      ok: true,
      file_ref: "file_bead1234.txt",
      file_id: "file_file_1",
      deliveredAs: "text_fallback",
      queued: true
    });
    assert.equal(queuedTasks.length, 1);

    await queuedTasks[0]!();

    assert.deepEqual(webChunks, ["chat file 已发送：file_bead1234.txt；file_id=file_file_1"]);
    assert.deepEqual(assistantHistoryCalls, [{
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "chat file 已发送：file_bead1234.txt；file_id=file_file_1"
    }]);
  });

  test("chat_file_send_to_chat records image sends for web delivery", async () => {
    const transcriptCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-web-"));
    const imagePath = join(tempDir, "test.png");
    await writeFile(imagePath, Buffer.from("fake-image-bytes"));

    try {
      const result = await chatFileToolHandlers.chat_file_send_to_chat!(
        { id: "tool_workspace_send_web_img", type: "function", function: { name: "chat_file_send_to_chat", arguments: "{\"file_ref\":\"img_deadbeef.png\"}" } },
        { file_ref: "img_deadbeef.png" },
        {
          replyDelivery: "web",
          lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
          chatFileStore: {
            async getFile(id: string) {
              if (id !== "img_deadbeef.png" && id !== "file_img_1") {
                return null;
              }
              return {
                fileId: "file_img_1",
                fileRef: "img_deadbeef.png",
                kind: "image",
                sourceName: "test.png",
                chatFilePath: "workspace/media/file_img_1.png"
              };
            },
            async listFiles() {
              return [];
            },
            async resolveAbsolutePath() {
              return imagePath;
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            appendInternalTranscript(_sessionId: string, item: unknown) {
              transcriptCalls.push(item);
            }
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        file_ref: "img_deadbeef.png",
        file_id: "file_img_1",
        deliveredAs: "image",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);

      await queuedTasks[0]!();

      assert.deepEqual(transcriptCalls[0], {
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "web",
        mediaKind: "image",
        fileId: "file_img_1",
        fileRef: "img_deadbeef.png",
        sourceName: "test.png",
        chatFilePath: "workspace/media/file_img_1.png",
        sourcePath: null,
        messageId: null,
        toolName: "chat_file_send_to_chat",
        captionText: null,
        timestampMs: transcriptCalls[0].timestampMs
      });
      assert.equal(typeof transcriptCalls[0].timestampMs, "number");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("chat_file_send_to_chat accepts stored filenames as file_ref", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-ref-"));
    const imagePath = join(tempDir, "file_deadbeef.jpg");
    await writeFile(imagePath, Buffer.from("fake-image-bytes"));
    const queuedTasks: Array<() => Promise<void>> = [];
    const sentMessages: any[] = [];
    try {
      const result = await chatFileToolHandlers.chat_file_send_to_chat!(
        { id: "tool_workspace_send_3", type: "function", function: { name: "chat_file_send_to_chat", arguments: "{\"file_ref\":\"file_deadbeef.jpg\"}" } },
        { file_ref: "file_deadbeef.jpg" },
        {
          lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
          chatFileStore: {
            async getFile(id: string) {
              if (id === "file_deadbeef") {
                return {
                  fileId: "file_deadbeef",
                  fileRef: "img_deadbeef.jpg",
                  kind: "image",
                  origin: "local_file_import",
                  chatFilePath: "workspace/media/file_deadbeef.jpg",
                  sourceName: "photo.jpg",
                  mimeType: "image/jpeg",
                  sizeBytes: 123,
                  createdAtMs: 1,
                  sourceContext: {},
                  caption: null
                };
              }
              return null;
            },
            async listFiles() {
              return [{
                fileId: "file_deadbeef",
                fileRef: "img_deadbeef.jpg",
                kind: "image",
                origin: "local_file_import",
                chatFilePath: "workspace/media/file_deadbeef.jpg",
                sourceName: "photo.jpg",
                mimeType: "image/jpeg",
                sizeBytes: 123,
                createdAtMs: 1,
                sourceContext: {},
                caption: null
              }];
            },
            async resolveAbsolutePath() {
              return imagePath;
            }
          },
          oneBotClient: {
            async sendMessage(params: unknown) {
              sentMessages.push(params);
              return { status: "ok", retcode: 0, data: { message_id: 99 } };
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            recordSentMessage() {},
            appendInternalTranscript() {}
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        file_ref: "img_deadbeef.jpg",
        file_id: "file_deadbeef",
        deliveredAs: "image",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);
      assert.equal(sentMessages.length, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("local_file_send_to_chat sends workspace-relative image", async () => {
    const queuedTasks: Array<() => Promise<void>> = [];
    const sentMessages: any[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-path-rel-"));
    const imagePath = join(tempDir, "diagram.png");
    const imageBytes = Buffer.from("fake-image-bytes");
    await writeFile(imagePath, imageBytes);

    try {
      const result = await localFileToolHandlers.local_file_send_to_chat!(
        { id: "tool_workspace_send_path_rel", type: "function", function: { name: "local_file_send_to_chat", arguments: "{\"path\":\"outputs/diagram.png\"}" } },
        { path: "outputs/diagram.png" },
        {
          config: createTestAppConfig(),
          lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
          localFileService: {
            resolvePath(relativePath: string) {
              assert.equal(relativePath, "outputs/diagram.png");
              return {
                relativePath: "outputs/diagram.png",
                absolutePath: imagePath
              };
            }
          },
          chatFileStore: {
            async resolveAbsolutePath() {
              throw new Error("should not be called");
            }
          },
          oneBotClient: {
            async sendMessage(params: unknown) {
              sentMessages.push(params);
              return { status: "ok", retcode: 0, data: { message_id: 55 } };
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            recordSentMessage() {},
            appendInternalTranscript() {}
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        path: "outputs/diagram.png",
        path_mode: "workspace_relative",
        deliveredAs: "image",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);

      await queuedTasks[0]!();

      assert.deepEqual(sentMessages[0], {
        userId: "owner",
        message: [
          { type: "image", data: { file: `base64://${imageBytes.toString("base64")}` } }
        ]
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("local_file_send_to_chat sends file via absolute path", async () => {
    const queuedTasks: Array<() => Promise<void>> = [];
    const sentTexts: any[] = [];
    const assistantHistoryCalls: any[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-path-abs-"));
    const filePath = join(tempDir, "report.txt");
    await writeFile(filePath, "hello", "utf8");

    try {
      const result = await localFileToolHandlers.local_file_send_to_chat!(
        { id: "tool_workspace_send_path_abs", type: "function", function: { name: "local_file_send_to_chat", arguments: `{\"path\":\"${filePath}\"}` } },
        { path: filePath },
        {
          config: createTestAppConfig(),
          lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
          oneBotClient: {
            async sendText(params: unknown) {
              sentTexts.push(params);
              return { status: "ok", retcode: 0, data: { message_id: 77 } };
            }
          },
          messageQueue: {
            enqueueTextDetached(params: { send: () => Promise<void> }) {
              queuedTasks.push(params.send);
            }
          },
          sessionManager: {
            recordSentMessage() {},
            appendAssistantHistory(_sessionId: string, message: unknown) {
              assistantHistoryCalls.push(message);
            }
          }
        } as any
      );

      assert.deepEqual(JSON.parse(String((result as any).content ?? result)), {
        ok: true,
        path: filePath,
        path_mode: "absolute",
        deliveredAs: "text_fallback",
        queued: true
      });
      assert.equal(queuedTasks.length, 1);

      await queuedTasks[0]!();

      assert.deepEqual(sentTexts[0], {
        userId: "owner",
        text: `文件已发送：${filePath}`
      });
      assert.deepEqual(assistantHistoryCalls[0], {
        chatType: "private",
        userId: "owner",
        senderName: "Owner",
        text: `文件已发送：${filePath}`,
        deliveryRef: {
          platform: "onebot",
          messageId: 77
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("local_file_send_to_chat resolves relative path through localFileService", async () => {
    const result = await localFileToolHandlers.local_file_send_to_chat!(
      { id: "tool_workspace_send_path_rel_resolve", type: "function", function: { name: "local_file_send_to_chat", arguments: "{\"path\":\"outputs/demo.txt\"}" } },
      { path: "outputs/demo.txt" },
      {
        config: createTestAppConfig(),
        lastMessage: { sessionId: "qqbot:p:owner", userId: "owner", senderName: "Owner" },
        localFileService: {
          resolvePath(relativePath: string) {
            assert.equal(relativePath, "outputs/demo.txt");
            return {
              relativePath,
              absolutePath: "/project/data/outputs/demo.txt"
            };
          }
        },
        messageQueue: {
          enqueueTextDetached() {}
        }
      } as any
    );

    assert.equal(JSON.parse(String((result as any).content ?? result)).path, "outputs/demo.txt");
  });

  test("list_live_resources merges browser and shell resources", async () => {
    const result = await resourceToolHandlers.list_live_resources!(
      { id: "tool_resource_list_1", type: "function", function: { name: "list_live_resources", arguments: "{}" } },
      {},
      {
        config: createForwardFeatureConfig(),
        browserService: {
          async listPages() {
            return {
              ok: true,
              pages: [{
                resource_id: "res_browser_1",
                status: "active",
                title: "OpenAI",
                description: "查看首页文案",
                summary: "OpenAI",
                requestedUrl: "https://openai.com",
                resolvedUrl: "https://openai.com",
                backend: "playwright",
                profile_id: null,
                createdAtMs: 1,
                lastAccessedAtMs: 10,
                expiresAtMs: 100
              }]
            };
          }
        },
        shellRuntime: {
          async listSessionResources() {
            return [{
              resource_id: "res_shell_1",
              status: "active",
              command: "pwd",
              cwd: "/tmp",
              shell: "/bin/sh",
              login: true,
              tty: true,
              title: "pwd @ /tmp",
              description: "查看当前工作目录",
              summary: "pwd (cwd=/tmp)",
              createdAtMs: 2,
              lastAccessedAtMs: 20,
              expiresAtMs: null
            }];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.live_resources.map((item: any) => item.resource_id), ["res_shell_1", "res_browser_1"]);
    assert.equal(payload.live_resources[0].description, "查看当前工作目录");
    assert.equal(payload.live_resources[1].description, "查看首页文案");
  });

  test("list_live_resources only returns valid active resources", async () => {
    const result = await resourceToolHandlers.list_live_resources!(
      { id: "tool_resource_list_2", type: "function", function: { name: "list_live_resources", arguments: "{}" } },
      {},
      {
        config: createForwardFeatureConfig(),
        browserService: {
          async listPages() {
            return {
              ok: true,
              pages: [{
                resource_id: "res_browser_live",
                status: "active",
                title: "Live page",
                description: "继续支付流程",
                summary: "Live page",
                requestedUrl: "https://example.com/live",
                resolvedUrl: "https://example.com/live",
                backend: "playwright",
                profile_id: null,
                createdAtMs: 1,
                lastAccessedAtMs: 3,
                expiresAtMs: 100
              }]
            };
          }
        },
        shellRuntime: {
          async listSessionResources() {
            return [{
              resource_id: "res_shell_live",
              status: "active",
              command: "pwd",
              cwd: "/tmp",
              shell: "/bin/sh",
              login: true,
              tty: true,
              title: "pwd @ /tmp",
              description: "查看当前工作目录",
              summary: "pwd (cwd=/tmp)",
              createdAtMs: 2,
              lastAccessedAtMs: 4,
              expiresAtMs: null
            }];
          }
        }
      } as any
    );

    const payload = JSON.parse(String(result));
    assert.deepEqual(payload.live_resources.map((item: any) => item.resource_id), ["res_shell_live", "res_browser_live"]);
    assert.equal(payload.live_resources.every((item: any) => item.status === "active"), true);
    assert.equal(payload.live_resources[0].description, "查看当前工作目录");
    assert.equal(payload.live_resources[1].description, "继续支付流程");
  });

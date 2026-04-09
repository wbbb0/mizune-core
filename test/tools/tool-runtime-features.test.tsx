import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinTools } from "../../src/llm/tools/index.ts";
import { sessionToolHandlers } from "../../src/llm/tools/conversation/sessionTools.ts";
import { resourceToolHandlers } from "../../src/llm/tools/runtime/resourceTools.ts";
import { debugToolHandlers } from "../../src/llm/tools/runtime/debugTools.ts";
import { shellToolHandlers } from "../../src/llm/tools/runtime/shellTools.ts";
import { timeToolHandlers } from "../../src/llm/tools/runtime/timeTools.ts";
import { workspaceToolHandlers } from "../../src/llm/tools/runtime/workspaceTools.ts";
import { profileToolHandlers } from "../../src/llm/tools/profile/profileTools.ts";
import { createForwardFeatureConfig, runCase } from "../helpers/forward-test-support.tsx";

async function main() {
  await runCase("builtin tool list exposes forward, media, and message tools", async () => {
    const config = createForwardFeatureConfig();
    config.search.aliyunIqs.enabled = true;
    config.shell.enabled = true;
    config.shell.mode = "full";
    const names = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    assert.ok(names.includes("end_turn_without_reply"));
    assert.ok(names.includes("get_current_time"));
    assert.ok(names.includes("view_forward_record"));
    assert.ok(names.includes("view_media"));
    assert.ok(names.includes("view_message"));
    assert.ok(names.includes("list_workspace_files"));
    assert.ok(names.includes("send_workspace_file_to_chat"));
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

  await runCase("builtin tool list hides web tools when search is disabled", async () => {
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

  await runCase("builtin tool list hides external search tools when provider native search is enabled", async () => {
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

  await runCase("all object tool schemas expose properties for provider compatibility", async () => {
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

  await runCase("debug-only tools stay hidden unless the current turn is in debug mode", async () => {
    const config = createForwardFeatureConfig();
    assert.ok(!getBuiltinTools("owner", config).map((tool) => tool.function.name).includes("dump_debug_literals"));
    assert.ok(getBuiltinTools("owner", config, undefined, {
      includeDebugTools: true
    }).map((tool) => tool.function.name).includes("dump_debug_literals"));
  });

  await runCase("memory tool descriptions cover persona read/write surface", async () => {
    const config = createForwardFeatureConfig();
    const tools = getBuiltinTools("owner", config);
    const readMemory = tools.find((tool) => tool.function.name === "read_memory");
    const writeMemory = tools.find((tool) => tool.function.name === "write_memory");
    assert.match(String(readMemory?.function.description ?? ""), /scope=global|scope=user|scope=persona/);
    assert.match(String(writeMemory?.function.description ?? ""), /scope=global\|user|scope=persona/);
  });

  await runCase("memory tools are exposed to both owner and known users", async () => {
    const config = createForwardFeatureConfig();
    const ownerNames = getBuiltinTools("owner", config).map((tool) => tool.function.name);
    const knownNames = getBuiltinTools("known", config).map((tool) => tool.function.name);
    assert.ok(ownerNames.includes("read_memory"));
    assert.ok(ownerNames.includes("write_memory"));
    assert.ok(ownerNames.includes("remove_memory"));
    assert.ok(knownNames.includes("read_memory"));
    assert.ok(knownNames.includes("write_memory"));
    assert.ok(knownNames.includes("remove_memory"));
  });

  await runCase("global memory handlers allow owner and reject non-owner", async () => {
    const ownerResult = await profileToolHandlers.write_memory!(
      { id: "tool_global_memory_1", type: "function", function: { name: "write_memory", arguments: "{\"scope\":\"global\",\"title\":\"输出顺序\",\"content\":\"先结论后细节\"}" } },
      { scope: "global", title: "输出顺序", content: "先结论后细节" },
      {
        relationship: "owner",
        globalMemoryStore: {
          async upsert(input: { title: string; content: string }) {
            return [{ id: "mem_1", updatedAt: 1, ...input }];
          }
        }
      } as any
    );
    assert.equal(JSON.parse(String(ownerResult))[0].title, "输出顺序");

    const deniedResult = await profileToolHandlers.write_memory!(
      { id: "tool_global_memory_2", type: "function", function: { name: "write_memory", arguments: "{\"scope\":\"global\",\"title\":\"输出顺序\",\"content\":\"先结论后细节\"}" } },
      { scope: "global", title: "输出顺序", content: "先结论后细节" },
      {
        relationship: "known",
        globalMemoryStore: {}
      } as any
    );
    assert.match(String(deniedResult), /Only owner can edit global memories/);
  });

  await runCase("scheduler tool description emphasizes future triggers and self-contained instructions", async () => {
    const config = createForwardFeatureConfig();
    const tools = getBuiltinTools("owner", config);
    const createJob = tools.find((tool) => tool.function.name === "create_scheduled_job");
    assert.match(String(createJob?.function.description ?? ""), /未来某时提醒、延后处理或定期执行/);
    assert.match(String(createJob?.function.description ?? ""), /触发当时可直接执行的完整任务/);
    assert.match(String(createJob?.function.description ?? ""), /查资料、看图或调用其他工具/);
  });

  await runCase("end_turn_without_reply requests a terminal empty response", async () => {
    const result = await sessionToolHandlers.end_turn_without_reply!(
      { id: "tool_end_turn_1", type: "function", function: { name: "end_turn_without_reply", arguments: "{\"reason\":\"明确收尾\"}" } },
      { reason: "明确收尾" },
      {} as any
    );

    assert.equal(typeof result, "object");
    assert.equal(JSON.parse(String((result as any).content)).ended, true);
    assert.equal((result as any).terminalResponse?.text, "");
  });

  await runCase("get_current_time returns configured timezone and precise clock values", async () => {
    const result = await timeToolHandlers.get_current_time!(
      { id: "tool_time_1", type: "function", function: { name: "get_current_time", arguments: "{}" } },
      {},
      {
        config: createForwardFeatureConfig(),
        relationship: "owner",
        lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
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
        mediaWorkspace: {},
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

  await runCase("shell_run forwards resource description", async () => {
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

  await runCase("list_live_resources supports shell-only filtering", async () => {
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

  await runCase("dump_debug_literals pushes one literal per outbound message without writing history", async () => {
    const sentMetaCalls: any[] = [];
    const sentMessages: any[] = [];
    const result = await debugToolHandlers.dump_debug_literals!(
      { id: "tool_debug_dump_1", type: "function", function: { name: "dump_debug_literals", arguments: "{\"literals\":[\"full_system_prompt\",\"persona\"]}" } },
      { literals: ["full_system_prompt", "persona"] },
      {
        relationship: "owner",
        lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
        debugSnapshot: {
          sessionId: "private:owner",
          systemMessages: ["system prompt"],
          visibleToolNames: [],
          historySummary: null,
          recentHistory: [],
          currentBatch: [],
          liveResources: [],
          recentToolEvents: [],
          debugMarkers: [],
          toolTranscript: [],
          persona: { name: "Test Persona" },
          globalMemories: [],
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
    assert.deepEqual(sentMessages[0], { userId: "owner", text: "system prompt" });
    assert.match(sentMessages[1].text, /Test Persona/);
    assert.equal(sentMetaCalls.length, 3);
    assert.equal(sentMetaCalls[2].kind, "marker");
    assert.equal((result as any).terminalResponse?.text, "");
  });

  await runCase("send_workspace_file_to_chat rejects text when sending an image", async () => {
    const result = await workspaceToolHandlers.send_workspace_file_to_chat!(
      { id: "tool_workspace_send_text_reject", type: "function", function: { name: "send_workspace_file_to_chat", arguments: "{\"file_id\":\"file_img_1\",\"text\":\"发你了\"}" } },
      { file_ref: "img_deadbeef.png", text: "发你了" },
      {
        lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
        mediaWorkspace: {
          async getFile(id: string) {
            if (id !== "img_deadbeef.png" && id !== "file_img_1") {
              return null;
            }
            return {
              fileId: "file_img_1",
              fileRef: "img_deadbeef.png",
              kind: "image",
              sourceName: "test.png",
              workspacePath: "workspace/media/file_img_1.png"
            };
          },
          async listFiles() {
            return [];
          }
        }
      } as any
    );

    assert.deepEqual(JSON.parse(String(result)), {
      error: "send_workspace_file_to_chat 发送图片时不能附带 text；若需要文字，请让模型单独发送回复"
    });
  });

  await runCase("send_workspace_file_to_chat sends a pure image and keeps the turn open", async () => {
    const sentMessages: any[] = [];
    const sentMetaCalls: any[] = [];
    const transcriptCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-"));
    const imagePath = join(tempDir, "test.png");
    const imageBytes = Buffer.from("fake-image-bytes");
    await writeFile(imagePath, imageBytes);

    try {
    const result = await workspaceToolHandlers.send_workspace_file_to_chat!(
      { id: "tool_workspace_send_1", type: "function", function: { name: "send_workspace_file_to_chat", arguments: "{\"file_ref\":\"img_deadbeef.png\"}" } },
      { file_ref: "img_deadbeef.png" },
      {
        lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
        mediaWorkspace: {
          async getFile(id: string) {
            if (id !== "img_deadbeef.png" && id !== "file_img_1") {
              return null;
            }
            return {
              fileId: "file_img_1",
              fileRef: "img_deadbeef.png",
              kind: "image",
              sourceName: "test.png",
              workspacePath: "workspace/media/file_img_1.png"
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
      workspacePath: "workspace/media/file_img_1.png",
      messageId: 42,
      toolName: "send_workspace_file_to_chat",
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

  await runCase("send_workspace_file_to_chat keeps the turn open for non-image fallback sends", async () => {
    const sentTexts: any[] = [];
    const sentMetaCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const result = await workspaceToolHandlers.send_workspace_file_to_chat!(
      { id: "tool_workspace_send_2", type: "function", function: { name: "send_workspace_file_to_chat", arguments: "{\"file_ref\":\"file_bead1234.txt\"}" } },
      { file_ref: "file_bead1234.txt" },
      {
        lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
        mediaWorkspace: {
          async getFile(id: string) {
            if (id !== "file_bead1234.txt" && id !== "file_file_1") {
              return null;
            }
            return {
              fileId: "file_file_1",
              fileRef: "file_bead1234.txt",
              kind: "file",
              sourceName: "note.txt",
              workspacePath: "workspace/media/file_file_1.txt"
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
      queued: true,
      reason: "native file sending is not enabled in this phase"
    });

    await queuedTasks[0]!();

    assert.equal(sentTexts.length, 1);
    assert.deepEqual(sentTexts[0], {
      userId: "owner",
      text: "文件已保存在工作区：file_bead1234.txt；file_id=file_file_1"
    });
    assert.deepEqual(sentMetaCalls[0], {
      messageId: 43,
      text: "文件已保存在工作区：file_bead1234.txt；file_id=file_file_1",
      sentAt: sentMetaCalls[0].sentAt
    });
    assert.equal(typeof sentMetaCalls[0].sentAt, "number");
    assert.equal((result as any).terminalResponse, undefined);
  });

  await runCase("send_workspace_file_to_chat mirrors non-image fallback text into web delivery", async () => {
    const webChunks: string[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const assistantHistoryCalls: any[] = [];

    const result = await workspaceToolHandlers.send_workspace_file_to_chat!(
      { id: "tool_workspace_send_2_web", type: "function", function: { name: "send_workspace_file_to_chat", arguments: "{\"file_ref\":\"file_bead1234.txt\"}" } },
      { file_ref: "file_bead1234.txt" },
      {
        replyDelivery: "web",
        webOutputCollector: {
          append(chunk: string) {
            webChunks.push(chunk);
          }
        },
        lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
        mediaWorkspace: {
          async getFile(id: string) {
            if (id !== "file_bead1234.txt" && id !== "file_file_1") {
              return null;
            }
            return {
              fileId: "file_file_1",
              fileRef: "file_bead1234.txt",
              kind: "file",
              sourceName: "note.txt",
              workspacePath: "workspace/media/file_file_1.txt"
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
      queued: true,
      reason: "native file sending is not enabled in this phase"
    });
    assert.equal(queuedTasks.length, 1);

    await queuedTasks[0]!();

    assert.deepEqual(webChunks, ["文件已保存在工作区：file_bead1234.txt；file_id=file_file_1"]);
    assert.deepEqual(assistantHistoryCalls, [{
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "文件已保存在工作区：file_bead1234.txt；file_id=file_file_1"
    }]);
  });

  await runCase("send_workspace_file_to_chat records image sends for web delivery", async () => {
    const transcriptCalls: any[] = [];
    const queuedTasks: Array<() => Promise<void>> = [];
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-web-"));
    const imagePath = join(tempDir, "test.png");
    await writeFile(imagePath, Buffer.from("fake-image-bytes"));

    try {
      const result = await workspaceToolHandlers.send_workspace_file_to_chat!(
        { id: "tool_workspace_send_web_img", type: "function", function: { name: "send_workspace_file_to_chat", arguments: "{\"file_ref\":\"img_deadbeef.png\"}" } },
        { file_ref: "img_deadbeef.png" },
        {
          replyDelivery: "web",
          lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
          mediaWorkspace: {
            async getFile(id: string) {
              if (id !== "img_deadbeef.png" && id !== "file_img_1") {
                return null;
              }
              return {
                fileId: "file_img_1",
                fileRef: "img_deadbeef.png",
                kind: "image",
                sourceName: "test.png",
                workspacePath: "workspace/media/file_img_1.png"
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
        workspacePath: "workspace/media/file_img_1.png",
        messageId: null,
        toolName: "send_workspace_file_to_chat",
        captionText: null,
        timestampMs: transcriptCalls[0].timestampMs
      });
      assert.equal(typeof transcriptCalls[0].timestampMs, "number");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  await runCase("send_workspace_file_to_chat accepts stored filenames as file_ref", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-tool-ref-"));
    const imagePath = join(tempDir, "file_deadbeef.jpg");
    await writeFile(imagePath, Buffer.from("fake-image-bytes"));
    const queuedTasks: Array<() => Promise<void>> = [];
    const sentMessages: any[] = [];
    try {
      const result = await workspaceToolHandlers.send_workspace_file_to_chat!(
        { id: "tool_workspace_send_3", type: "function", function: { name: "send_workspace_file_to_chat", arguments: "{\"file_ref\":\"file_deadbeef.jpg\"}" } },
        { file_ref: "file_deadbeef.jpg" },
        {
          lastMessage: { sessionId: "private:owner", userId: "owner", senderName: "Owner" },
          mediaWorkspace: {
            async getFile(id: string) {
              if (id === "file_deadbeef") {
                return {
                  fileId: "file_deadbeef",
                  fileRef: "img_deadbeef.jpg",
                  kind: "image",
                  origin: "workspace_import",
                  workspacePath: "workspace/media/file_deadbeef.jpg",
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
                origin: "workspace_import",
                workspacePath: "workspace/media/file_deadbeef.jpg",
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

  await runCase("list_live_resources merges browser and shell resources", async () => {
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

  await runCase("list_live_resources only returns valid active resources", async () => {
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("internal api exposes config, whitelist, requests, and scheduler jobs", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const [configSummary, editors, configEditor, whitelist, requests, jobs] = await Promise.all([
        app.inject({ method: "GET", url: "/api/config-summary" }),
        app.inject({ method: "GET", url: "/api/editors" }),
        app.inject({ method: "GET", url: "/api/editors/config" }),
        app.inject({ method: "GET", url: "/api/whitelist" }),
        app.inject({ method: "GET", url: "/api/requests" }),
        app.inject({ method: "GET", url: "/api/scheduler/jobs" })
      ]);

      assert.equal(configSummary.statusCode, 200);
      assert.equal(editors.statusCode, 200);
      assert.equal(configEditor.statusCode, 200);
      assert.equal(configSummary.json().runtimeMode, "onebot");
      assert.equal(configSummary.json().access.ownerId, "10001");
      assert.deepEqual(configSummary.json().access.whitelist.users, ["10001"]);
      assert.equal(configSummary.json().onebot.enabled, true);
      assert.ok(editors.json().resources.some((resource: { key: string }) => resource.key === "config"));
      assert.ok(editors.json().resources.some((resource: { key: string }) => resource.key === "whitelist"));
      assert.equal(configEditor.json().editor.schemaMeta.kind, "object");
      assert.equal(configEditor.json().editor.uiTree.kind, "group");
      assert.deepEqual(configEditor.json().editor.layerFeatures, {
        showBackdrop: true,
        allowRestoreInherited: true
      });
      assert.deepEqual(whitelist.json().whitelist.users, ["10001"]);
      assert.deepEqual(requests.json().requests.groups, [{ groupId: "20002", userId: "10003" }]);
      assert.deepEqual(jobs.json().jobs, [{ id: "job-1", name: "daily" }]);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api validates send-text target selection", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/send-text",
        payload: { text: "hello" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "userId/groupId and text are required");
    } finally {
      await app.close();
    }
  });

  await runCase("internal api validates and saves config editor values", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      await mkdir("/tmp/llm-bot-test-config/instances", { recursive: true });
      await writeFile("/tmp/llm-bot-test-config/global.yml", [
        "appName: global-app",
        "nodeEnv: production",
        "logLevel: info",
        "onebot:",
        "  wsUrl: ws://global.example/ws"
      ].join("\n"), "utf8");
      const value = {
        appName: "saved-from-webui",
        logLevel: "silent"
      };
      const editorResponse = await app.inject({
        method: "GET",
        url: "/api/editors/config"
      });
      assert.equal(editorResponse.statusCode, 200);
      assert.equal(editorResponse.json().editor.baseValue.appName, "global-app");
      assert.equal(editorResponse.json().editor.currentValue.appName, undefined);
      assert.equal(editorResponse.json().editor.effectiveValue.appName, "global-app");

      const validateResponse = await app.inject({
        method: "POST",
        url: "/api/editors/config/validate",
        payload: { value }
      });
      assert.equal(validateResponse.statusCode, 200);
      assert.equal(validateResponse.json().ok, true);
      assert.equal(validateResponse.json().parsed.appName, "saved-from-webui");
      assert.equal(validateResponse.json().effective.onebot.wsUrl, "ws://global.example/ws");

      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/editors/config/save",
        payload: {
          value
        }
      });
      assert.equal(saveResponse.statusCode, 200);
      assert.equal(saveResponse.json().path, "/tmp/llm-bot-test-config/instances/test.yml");
      assert.equal(deps.__state.configCheckForUpdatesCount, 1);
      const saved = await readFile("/tmp/llm-bot-test-config/instances/test.yml", "utf8");
      assert.match(saved, /appName: saved-from-webui/);
      assert.doesNotMatch(saved, /onebot:/);
      assert.doesNotMatch(saved, /nodeEnv: production/);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api exposes single-file editor resources", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      await mkdir(deps.config.dataDir, { recursive: true });
      const whitelistPath = `${deps.config.dataDir}/whitelist.json`;
      await writeFile(whitelistPath, JSON.stringify({
        ownerId: "10001",
        users: ["10001"],
        groups: ["20001"]
      }, null, 2), "utf8");

      const response = await app.inject({
        method: "GET",
        url: "/api/editors/whitelist"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().editor.kind, "single");
      assert.equal(response.json().editor.file.path, whitelistPath);
      assert.deepEqual(response.json().editor.current.users, ["10001"]);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api returns not found for unknown shell session", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/shell/sessions/missing"
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "Shell session not found");
    } finally {
      await app.close();
    }
  });

  await runCase("internal api exposes session detail", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/private:10001"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().session.id, "private:10001");
      assert.equal(response.json().session.modeId, "rp_assistant");
      assert.equal(response.json().session.historyRevision, 0);
      assert.equal(response.json().modeState, null);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api exposes scenario_host mode state in session detail", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/private:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/private:10001"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().modeState.kind, "scenario_host");
      assert.equal(response.json().modeState.state.player.userId, "10001");
      assert.equal(response.json().modeState.state.title, "未命名场景");
    } finally {
      await app.close();
    }
  });

  await runCase("internal api updates scenario_host mode state", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/private:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const updateResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/private:10001/mode-state",
        payload: {
          state: {
            version: 1,
            title: "雾港夜巡",
            currentSituation: "码头上空有钟声回荡。",
            currentLocation: "旧港码头",
            sceneSummary: "玩家刚抵达旧港。",
            player: {
              userId: "10001",
              displayName: "Alice"
            },
            inventory: [{ ownerId: "10001", item: "铜钥匙", quantity: 1 }],
            objectives: [{ id: "find-bell", title: "找到钟楼", status: "active", summary: "先去高处确认钟声来源" }],
            worldFacts: ["旧港每晚零点都会响钟。"],
            flags: { alerted: true, suspicion: 2 },
            initialized: true,
            turnIndex: 3
          }
        }
      });

      assert.equal(updateResponse.statusCode, 200);
      assert.equal(updateResponse.json().modeState.kind, "scenario_host");
      assert.equal(updateResponse.json().modeState.state.title, "雾港夜巡");
      assert.equal(updateResponse.json().modeState.state.initialized, true);
      assert.deepEqual(updateResponse.json().modeState.state.inventory, [{ ownerId: "10001", item: "铜钥匙", quantity: 1 }]);

      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/private:10001"
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().modeState.state.currentLocation, "旧港码头");
      assert.equal(response.json().modeState.state.turnIndex, 3);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api rejects mode state updates for non-scenario sessions", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/sessions/private:10001/mode-state",
        payload: {
          state: {
            version: 1
          }
        }
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /scenario_host/i);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api rejects invalid scenario_host mode state payloads", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/private:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);

      const response = await app.inject({
        method: "PATCH",
        url: "/api/sessions/private:10001/mode-state",
        payload: {
          state: {
            version: 1,
            title: "坏数据"
          }
        }
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /currentSituation|player|inventory|objectives|worldFacts|flags|initialized|turnIndex/i);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api exposes session modes and allows switching a session mode", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const modesResponse = await app.inject({
        method: "GET",
        url: "/api/session-modes"
      });
      assert.equal(modesResponse.statusCode, 200);
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

      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/private:10001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 200);
      assert.equal(switchResponse.json().session.modeId, "scenario_host");
    } finally {
      await app.close();
    }
  });

  await runCase("internal api rejects scenario_host for group sessions", async () => {
    const deps = createInternalApiDeps();
    deps.__state.sessions.push({
      id: "group:20001",
      type: "group",
      source: "onebot",
      modeId: "rp_assistant",
      participantUserId: "20001",
      participantLabel: "Group 20001",
      phase: { kind: "idle" },
      pendingMessages: [],
      internalTranscript: [],
      isGenerating: false,
      lastActiveAt: 123456
    });
    const app = await createInternalApiApp(deps);
    try {
      const switchResponse = await app.inject({
        method: "PATCH",
        url: "/api/sessions/group:20001/mode",
        payload: {
          modeId: "scenario_host"
        }
      });
      assert.equal(switchResponse.statusCode, 400);
      assert.match(switchResponse.json().error, /does not support group chat/);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api exposes workspace listing, text preview, workspace image content, and stored file content", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const [listResponse, statResponse, fileResponse, imageContentResponse, sendContentResponse, filesResponse, storedFileResponse, contentResponse] = await Promise.all([
        app.inject({ method: "GET", url: "/api/workspace/items" }),
        app.inject({ method: "GET", url: "/api/workspace/stat?path=notes.txt" }),
        app.inject({ method: "GET", url: "/api/workspace/file?path=notes.txt&startLine=1&endLine=2" }),
        app.inject({ method: "GET", url: "/api/workspace/content?path=photo.png" }),
        app.inject({ method: "GET", url: "/api/workspace/send-content?path=photo.png" }),
        app.inject({ method: "GET", url: "/api/workspace/files" }),
        app.inject({ method: "GET", url: "/api/workspace/files/asset_image_1" }),
        app.inject({ method: "GET", url: "/api/workspace/files/asset_image_1/content" })
      ]);

      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().items[0].path, "docs");
      assert.equal(statResponse.statusCode, 200);
      assert.equal(statResponse.json().path, "notes.txt");
      assert.equal(fileResponse.statusCode, 200);
      assert.equal(fileResponse.json().content, "line 1\nline 2");
      assert.equal(fileResponse.json().truncated, true);
      assert.equal(imageContentResponse.statusCode, 200);
      assert.equal(imageContentResponse.headers["content-type"], "image/png");
      assert.ok(imageContentResponse.body.length > 0);
      assert.equal(sendContentResponse.statusCode, 200);
      assert.equal(sendContentResponse.headers["content-type"], "image/png");
      assert.ok(sendContentResponse.body.length > 0);
      assert.equal(filesResponse.statusCode, 200);
      assert.equal(filesResponse.json().files[0].fileId, "asset_image_1");
      assert.equal(storedFileResponse.statusCode, 200);
      assert.equal(storedFileResponse.json().file.sourceName, "fixture.png");
      assert.equal(contentResponse.statusCode, 200);
      assert.equal(contentResponse.headers["content-type"], "image/png");
      assert.ok(contentResponse.body.length > 0);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api rejects workspace path escape and returns not found for missing stored file", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const badPathResponse = await app.inject({
        method: "GET",
        url: "/api/workspace/items?path=../escape"
      });
      assert.equal(badPathResponse.statusCode, 400);

      const missingFileResponse = await app.inject({
        method: "GET",
        url: "/api/workspace/files/missing_file"
      });
      assert.equal(missingFileResponse.statusCode, 404);
      assert.equal(missingFileResponse.json().error, "Workspace file not found");
    } finally {
      await app.close();
    }
  });

  await runCase("internal api rejects binary workspace files in text preview", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/workspace/file?path=photo.png"
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "Workspace file is not a text file: photo.png");
    } finally {
      await app.close();
    }
  });

  await runCase("internal api shell routes expose success payloads", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const [listResponse, getResponse, runResponse, interactResponse, readResponse, signalResponse, closeResponse] = await Promise.all([
        app.inject({ method: "GET", url: "/api/shell/sessions" }),
        app.inject({ method: "GET", url: "/api/shell/sessions/shell-1" }),
        app.inject({ method: "POST", url: "/api/shell/run", payload: { command: "pwd", cwd: "/tmp", tty: true } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/interact", payload: { input: "ls\n" } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/read" }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/signal", payload: { signal: "SIGTERM" } }),
        app.inject({ method: "POST", url: "/api/shell/sessions/shell-1/close" })
      ]);

      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().sessions[0].id, "shell-1");
      assert.equal(getResponse.statusCode, 200);
      assert.equal(getResponse.json().session.id, "shell-1");
      assert.equal(runResponse.statusCode, 200);
      assert.equal(runResponse.json().result.command, "pwd");
      assert.equal(interactResponse.json().output, "ls\n");
      assert.equal(readResponse.json().output, "pwd\n");
      assert.equal(signalResponse.json().session.signal, "SIGTERM");
      assert.deepEqual(closeResponse.json(), { ok: true });
      assert.deepEqual(deps.__state.closedSessionIds, ["shell-1"]);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api send-text sends to selected target", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/send-text",
        payload: { userId: "10001", text: "hello" }
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(deps.__state.sentMessages, [{ userId: "10001", text: "hello" }]);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api rejects send-text when onebot is disabled", async () => {
    const deps = createInternalApiDeps();
    deps.config.onebot.enabled = false;
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/send-text",
        payload: { userId: "10001", text: "hello" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "OneBot is disabled in the current runtime mode");
    } finally {
      await app.close();
    }
  });

  await runCase("config summary switches to webui-only semantics when onebot is disabled", async () => {
    const deps = createInternalApiDeps();
    deps.config.onebot.enabled = false;
    const app = await createInternalApiApp(deps);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/config-summary"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().runtimeMode, "webui_only");
      assert.equal(response.json().access.ownerId, null);
      assert.deepEqual(response.json().access.whitelist, {
        enabled: false,
        users: [],
        groups: []
      });
    } finally {
      await app.close();
    }
  });

  await runCase("internal api creates and deletes web sessions", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          participantUserId: "web-user-1",
          participantLabel: "Web User"
        }
      });

      assert.equal(createResponse.statusCode, 200);
      assert.equal(createResponse.json().session.source, "web");
      assert.equal(createResponse.json().session.participantUserId, "web-user-1");

      const sessionId = createResponse.json().session.id;
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/sessions"
      });
      assert.equal(listResponse.statusCode, 200);
      assert.ok(listResponse.json().sessions.some((item: { id: string }) => item.id === sessionId));

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent(sessionId)}`
      });
      assert.equal(deleteResponse.statusCode, 200);

      const finalListResponse = await app.inject({
        method: "GET",
        url: "/api/sessions"
      });
      assert.ok(!finalListResponse.json().sessions.some((item: { id: string }) => item.id === sessionId));
    } finally {
      await app.close();
    }
  });

  await runCase("internal api web-turn starts turn and streams page-scoped response without onebot send", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { participantUserId: "web-user-2", participantLabel: "Alice" }
      });
      const sessionId = createResponse.json().session.id;

      const startResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn`,
        payload: { userId: "10001", senderName: "Alice", text: "hello from web" }
      });

      assert.equal(startResponse.statusCode, 200);
      const turnId = startResponse.json().turnId;
      assert.equal(typeof turnId, "string");
      assert.ok(turnId.length > 0);

      const streamResponse = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn/stream?turnId=${encodeURIComponent(turnId)}`
      });

      assert.equal(streamResponse.statusCode, 200);
      assert.match(streamResponse.body, /event: ready/);
      assert.match(streamResponse.body, /event: chunk/);
      assert.match(streamResponse.body, new RegExp(`web handled: ${sessionId}: hello from web`));
      assert.match(streamResponse.body, /event: complete/);
      assert.deepEqual(deps.__state.sentMessages, []);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api web-turn can inject into onebot sessions without sending to onebot", async () => {
    const deps = createInternalApiDeps();
    const app = await createInternalApiApp(deps);
    try {
      const sessionId = "private:10001";
      const startResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn`,
        payload: { userId: "10001", senderName: "Alice", text: "hello from panel" }
      });

      assert.equal(startResponse.statusCode, 200);
      const turnId = startResponse.json().turnId;
      const streamResponse = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(sessionId)}/web-turn/stream?turnId=${encodeURIComponent(turnId)}`
      });

      assert.equal(streamResponse.statusCode, 200);
      assert.match(streamResponse.body, /event: chunk/);
      assert.match(streamResponse.body, /web handled: private:10001: hello from panel/);
      assert.deepEqual(deps.__state.sentMessages, []);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api invalidates transcript items and groups and triggers onebot deletion side effects", async () => {
    const deps = createInternalApiDeps();
    deps.__state.sessions[0]!.internalTranscript = [{
      id: "item-1",
      groupId: "group-1",
      runtimeExcluded: false,
      kind: "assistant_message",
      role: "assistant",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "hello",
      deliveryRef: {
        platform: "onebot",
        messageId: 41
      },
      timestampMs: 1
    }, {
      id: "item-2",
      groupId: "group-1",
      runtimeExcluded: false,
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: "working",
      timestampMs: 2
    }, {
      id: "item-3",
      groupId: "group-2",
      runtimeExcluded: false,
      kind: "assistant_message",
      role: "assistant",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "keep",
      timestampMs: 3
    }];
    const app = await createInternalApiApp(deps);
    try {
      const singleResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent("private:10001")}/transcript/items/item-1`
      });
      assert.equal(singleResponse.statusCode, 200);
      assert.deepEqual(singleResponse.json().excludedItemIds, ["item-1"]);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[0]!.runtimeExcluded, true);
      assert.deepEqual(deps.__state.deletedMessageIds, [41]);

      const groupResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent("private:10001")}/transcript/groups/group-1`
      });
      assert.equal(groupResponse.statusCode, 200);
      assert.deepEqual(groupResponse.json().excludedItemIds, ["item-2"]);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[1]!.runtimeExcluded, true);
      assert.equal(deps.__state.sessions[0]!.internalTranscript[2]!.runtimeExcluded, false);
    } finally {
      await app.close();
    }
  });

  await runCase("internal api accepts file upload payloads above the default fastify body limit", async () => {
    const app = await createInternalApiApp(createInternalApiDeps());
    try {
      const largeBuffer = Buffer.alloc(1024 * 1024 + 256 * 1024, 0xaa);
      const response = await app.inject({
        method: "POST",
        url: "/api/uploads/files",
        payload: {
          files: [{
            sourceName: "large.png",
            mimeType: "image/png",
            contentBase64: largeBuffer.toString("base64"),
            kind: "image"
          }]
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
      assert.equal(response.json().uploads[0].fileId, "asset_image_1");
      assert.equal(response.json().uploads[0].sizeBytes, largeBuffer.byteLength);
    } finally {
      await app.close();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

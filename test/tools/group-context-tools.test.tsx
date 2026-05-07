import test from "node:test";
import assert from "node:assert/strict";
import { groupContextToolDescriptors, groupContextToolHandlers } from "../../src/llm/tools/conversation/groupContextTools.ts";
import type { LlmToolCall } from "../../src/llm/llmClient.ts";

test("current group tools do not accept explicit group ids", () => {
  for (const descriptor of groupContextToolDescriptors) {
    const properties = descriptor.definition.function.parameters?.properties ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(properties, "groupId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(properties, "group_id"), false);
  }
});

test("view_current_group_info reads the current group from session id", async () => {
  let capturedGroupId = "";
  const result = await groupContextToolHandlers.view_current_group_info!(
    toolCall("view_current_group_info"),
    {},
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupInfo(groupId: string) {
          capturedGroupId = groupId;
          return {
            group_id: Number(groupId),
            group_name: "测试群",
            member_count: 42,
            max_member_count: 500
          };
        }
      },
      config: { onebot: { provider: "generic" } }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(capturedGroupId, "123456");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.groupId, "123456");
  assert.equal(parsed.groupName, "测试群");
  assert.match(parsed.summary, /测试群/);
});

test("current group tools reject private sessions", async () => {
  const result = await groupContextToolHandlers.list_current_group_members!(
    toolCall("list_current_group_members"),
    {},
    {
      lastMessage: { sessionId: "qqbot:p:10001", userId: "10001", senderName: "Alice" },
      oneBotClient: {}
    } as any
  );

  assert.equal(JSON.parse(String(result)).error, "current session is not a group chat");
});

test("list_current_group_members supports query and clamps limit", async () => {
  const result = await groupContextToolHandlers.list_current_group_members!(
    toolCall("list_current_group_members"),
    { query: "ali", limit: 999 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupMemberList(groupId: string) {
          assert.equal(groupId, "123456");
          return [
            { group_id: 123456, user_id: 10001, nickname: "Alice", card: "Ali", role: "member" },
            { group_id: 123456, user_id: 10002, nickname: "Bob", card: "Builder", role: "admin" }
          ];
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.totalMatched, 1);
  assert.equal(parsed.items[0].userId, "10001");
  assert.equal("searchText" in parsed.items[0], false);
});

test("list_current_group_announcements supports query and clamps limit", async () => {
  const result = await groupContextToolHandlers.list_current_group_announcements!(
    toolCall("list_current_group_announcements"),
    { query: "维护", limit: 999 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupAnnouncements(groupId: string) {
          assert.equal(groupId, "123456");
          return [
            { id: "n1", title: "维护通知", content: "今晚维护", sender_id: 10001, publish_time: 1710000000 },
            { id: "n2", title: "活动通知", content: "周末活动", sender_id: 10002, publish_time: 1710000100 }
          ];
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.limit, 30);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.totalMatched, 1);
  assert.equal(parsed.items[0].id, "n1");
  assert.equal(parsed.items[0].announcementIndex, 1);
  assert.equal(parsed.items[0].content, "今晚维护");
  assert.equal("searchText" in parsed.items[0], false);
});

test("view_current_group_info includes NapCat group details when available", async () => {
  const result = await groupContextToolHandlers.view_current_group_info!(
    toolCall("view_current_group_info"),
    {},
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      config: { onebot: { provider: "napcat" } },
      oneBotClient: {
        async getGroupInfo(groupId: string) {
          return {
            group_id: Number(groupId),
            group_name: "测试群",
            member_count: 42,
            max_member_count: 500
          };
        },
        async getGroupInfoEx(groupId: string) {
          assert.equal(groupId, "123456");
          return {
            group_id: 123456,
            group_name: "测试群",
            group_memo: "群介绍",
            group_create_time: 1700000000
          };
        },
        async getGroupAtAllRemain(groupId: string) {
          assert.equal(groupId, "123456");
          return {
            can_at_all: true,
            remain_at_all_count_for_group: 3,
            remain_at_all_count_for_uin: 1
          };
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.provider, "napcat");
  assert.equal(parsed.extended.group_memo, "群介绍");
  assert.equal(parsed.atAllRemain.remain_at_all_count_for_group, 3);
  assert.match(parsed.summary, /包含 NapCat 扩展资料/);
});

test("view_current_group_announcement reads full announcement by line range", async () => {
  const result = await groupContextToolHandlers.view_current_group_announcement!(
    toolCall("view_current_group_announcement"),
    { announcementId: "n1", startLine: 2, lineCount: 2 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupAnnouncements(groupId: string) {
          assert.equal(groupId, "123456");
          return [
            { id: "n1", title: "维护通知", content: "第一行\n第二行\n第三行\n第四行", sender_id: 10001, publish_time: 1710000000 }
          ];
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.announcementId, "n1");
  assert.equal(parsed.startLine, 2);
  assert.equal(parsed.endLine, 3);
  assert.equal(parsed.totalLines, 4);
  assert.equal(parsed.nextStartLine, 4);
  assert.equal(parsed.content, "第二行\n第三行");
});

test("view_current_group_announcement supports filtered list index", async () => {
  const result = await groupContextToolHandlers.view_current_group_announcement!(
    toolCall("view_current_group_announcement"),
    { query: "维护", announcementIndex: 2, lineCount: 1 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupAnnouncements() {
          return [
            { id: "n1", title: "维护 A", content: "A" },
            { id: "n2", title: "活动", content: "B" },
            { id: "n3", title: "维护 B", content: "C" }
          ];
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.announcementId, "n3");
  assert.equal(parsed.announcementIndex, 2);
  assert.equal(parsed.content, "C");
});

test("view_current_group_announcement reports char continuation inside a long line", async () => {
  const result = await groupContextToolHandlers.view_current_group_announcement!(
    toolCall("view_current_group_announcement"),
    { announcementId: "n1", lineCount: 1 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupAnnouncements() {
          return [
            { id: "n1", title: "长行", content: "A".repeat(9000) }
          ];
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.startLine, 1);
  assert.equal(parsed.endLine, 1);
  assert.equal(parsed.content.length, 8000);
  assert.equal(parsed.charTruncated, true);
  assert.equal(parsed.nextStartLine, 1);
  assert.equal(parsed.nextStartChar, 8000);
});

test("list_current_group_files lists folders and files from current group", async () => {
  const result = await groupContextToolHandlers.list_current_group_files!(
    toolCall("list_current_group_files"),
    { query: "report", limit: 10 },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupRootFiles(groupId: string) {
          assert.equal(groupId, "123456");
          return {
            folders: [{ folder_id: "folder-1", folder_name: "Reports", total_file_count: 2 }],
            files: [
              { file_id: "file-1", file_name: "report.pdf", file_size: 1024, busid: 1, uploader: 10001 },
              { file_id: "file-2", file_name: "photo.jpg", file_size: 2048, busid: 2 }
            ]
          };
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.folders[0].folderId, "folder-1");
  assert.equal(parsed.files[0].fileId, "file-1");
  assert.equal(parsed.files[0].busid, 1);
});

test("download_current_group_file resolves url and registers download handle", async () => {
  const result = await groupContextToolHandlers.download_current_group_file!(
    toolCall("download_current_group_file"),
    { fileId: "file-1", busid: 1, sourceName: "report.pdf", kind: "file" },
    {
      lastMessage: { sessionId: "qqbot:g:123456", userId: "u1", senderName: "Alice" },
      oneBotClient: {
        async getGroupFileUrl(groupId: string, fileId: string, busid: number) {
          assert.equal(groupId, "123456");
          assert.equal(fileId, "file-1");
          assert.equal(busid, 1);
          return { url: "https://example.com/report.pdf" };
        }
      },
      downloadRuntime: {
        async start(input: any) {
          assert.equal(input.sourceUrl, "https://example.com/report.pdf");
          assert.equal(input.origin, "group_file_download");
          assert.equal(input.proxyConsumer, "browser");
          assert.equal(input.sourceContext.group_id, "123456");
          assert.equal(input.sourceContext.group_file_id, "file-1");
          assert.equal(input.sourceContext.file_id, undefined);
          return {
            ok: true,
            resource_id: "res_download_1",
            status: "completed",
            source_url: input.sourceUrl,
            source_name: input.sourceName,
            origin: input.origin,
            downloaded_bytes: 1024,
            total_bytes: 1024,
            percent: 100,
            mime_type: "application/pdf",
            file_id: "file_saved_1",
            file_ref: "grp_saved.pdf",
            chat_file_path: "chat-files/media/grp_saved.pdf",
            kind: "file",
            size_bytes: 1024,
            error: null,
            created_at_ms: 1,
            updated_at_ms: 2
          };
        }
      },
      chatFileStore: {
        async getFile(fileId: string) {
          assert.equal(fileId, "file_saved_1");
          return {
            fileId,
            fileRef: "grp_saved.pdf",
            kind: "file",
            origin: "group_file_download",
            chatFilePath: "chat-files/media/grp_saved.pdf",
            sourceName: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            createdAtMs: 2,
            sourceContext: {},
            caption: null
          };
        }
      }
    } as any
  );

  const parsed = JSON.parse(String(result));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.group_file_id, "file-1");
  assert.equal(parsed.file_id, "file_saved_1");
  assert.equal(parsed.file_ref, "grp_saved.pdf");
  assert.equal(parsed.handle_capabilities.some((item: { capability: string }) => item.capability === "send_to_chat"), true);
});

function toolCall(name: string): LlmToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: {
      name,
      arguments: "{}"
    }
  };
}

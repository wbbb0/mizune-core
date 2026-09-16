import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import JSZip from "jszip";
import pino from "pino";
import { TemporaryWorkspaceService } from "../../src/services/workspace/temporaryWorkspaceService.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { extractWorkspaceZip, packWorkspaceZip, cloneWorkspaceRepository } from "../../src/services/workspace/workspaceFileOperations.ts";
import { registerTemporaryWorkspaceRoutes } from "../../src/internalApi/routes/temporaryWorkspaceRoutes.ts";
import { localFileToolDescriptors, localFileToolHandlers, chatFileToolHandlers } from "../../src/llm/tools/runtime/workspaceTools.ts";
import { temporaryWorkspaceToolHandlers } from "../../src/llm/tools/runtime/temporaryWorkspaceTools.ts";
import { resourceToolHandlers } from "../../src/llm/tools/runtime/resourceTools.ts";
import { getBuiltinTools } from "../../src/llm/tools/index.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

const actor = { sessionId: "group:123", userId: "user-1" };
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "temporary-workspace-test-"));
  const config = createTestAppConfig({ localFiles: { enabled: true, root: "data", maxPatchFileBytes: 1024 * 1024 }, chatFiles: { enabled: true } });
  let now = Date.now();
  const errors: unknown[] = [];
  const service = new TemporaryWorkspaceService(config, dir, (error) => errors.push(error), () => now);
  await service.init();
  t.after(async () => { await service.shutdown(); await rm(dir, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return { dir, config, service, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("temporary workspace survives restart and expires before the hourly cleanup", async (t) => {
  const f = await fixture(t);
  const w = await f.service.create(actor, "代码检查");
  assert.equal(w.expiresAtMs - w.createdAtMs, 86400000);
  let filePath = "";
  await f.service.withFiles(w.resource_id, actor, async (files) => { await files.writeFile("src/a.txt", "hello", "create"); filePath = files.resolvePath("src/a.txt").absolutePath; });
  await f.service.shutdown();
  const restarted = new TemporaryWorkspaceService(f.config, f.dir, () => {}, f.now);
  await restarted.init(); t.after(() => restarted.shutdown());
  assert.equal(restarted.list(actor)[0]?.status, "active");
  assert.equal(await restarted.withFiles(w.resource_id, actor, async (files) => (await files.readFile("src/a.txt")).content), "hello");
  f.advance(86400000);
  await assert.rejects(restarted.withFiles(w.resource_id, actor, (files) => files.readFile("src/a.txt")), /失效/);
  assert.equal((await stat(filePath)).isFile(), true);
  await restarted.sweep();
  await assert.rejects(stat(filePath), /ENOENT/);
  assert.equal(restarted.list(actor)[0]?.status, "expired");
});

test("workspace ownership, path traversal, links and root mutations are checked", async (t) => {
  const f = await fixture(t); const w = await f.service.create(actor);
  assert.deepEqual(f.service.list({ ...actor, userId: "other" }), []);
  await assert.rejects(f.service.withFiles(w.resource_id, { ...actor, userId: "other" }, (files) => files.listItems()), /无权/);
  await assert.rejects(f.service.close(w.resource_id, { ...actor, sessionId: "other" }), /无权/);
  await f.service.withFiles(w.resource_id, actor, async (files) => {
    for (const path of ["../outside", "/etc/passwd", "a/../../outside", "a\\b"]) assert.throws(() => files.resolvePath(path));
    await assert.rejects(files.deleteItem("."), /根目录/);
    await assert.rejects(files.moveItem(".", "other"), /根目录/);
    await writeFile(join(f.dir, "outside"), "secret");
    await symlink(join(f.dir, "outside"), join(files.rootDir, "link"));
    await assert.rejects(files.readFile("link"), /符号链接/);
    await assert.rejects(files.writeFile("link", "overwrite", "overwrite"), /符号链接/);
    await assert.rejects(files.findText("secret"), /符号链接/);
    await symlink(f.dir, join(files.rootDir, "dirlink"));
    await assert.rejects(files.writeFile("dirlink/outside", "overwrite", "overwrite"), /符号链接/);
  });
  assert.equal(await readFile(join(f.dir, "outside"), "utf8"), "secret");
});

test("ZIP operations preserve files and reject malicious paths and links without partial destinations", async (t) => {
  const f = await fixture(t); const w = await f.service.create(actor);
  await f.service.withFiles(w.resource_id, actor, async (files) => {
    await files.writeFile("src/a.txt", "original", "create");
    await packWorkspaceZip(files, ["src"], "bundle.zip");
    await extractWorkspaceZip(files, "bundle.zip", "unpacked");
    assert.equal((await files.readFile("unpacked/src/a.txt")).content, "original");
    for (const malicious of [new JSZip().file("../escape", "bad"), new JSZip().file("link", "/etc/passwd", { unixPermissions: 0o120777 })]) {
      await writeFile(files.resolvePath("bad.zip").absolutePath, await malicious.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
      await assert.rejects(extractWorkspaceZip(files, "bad.zip", "rejected"), /越界|链接/);
      await assert.rejects(files.statItem("rejected"), /ENOENT/);
    }
    await assert.rejects(cloneWorkspaceRepository(files, "file:///etc", "repo", Date.now() + 1000), /HTTPS/);
    await assert.rejects(cloneWorkspaceRepository(files, "https://127.0.0.1/repo", "repo", Date.now() + 1000), /公网/);
  });
});

test("filesystem tools preserve explicit paths and workspace selectors across import, edit and export", async (t) => {
  const f = await fixture(t); const w = await f.service.create(actor);
  const localFileService = new LocalFileService(f.config, f.dir); await localFileService.init();
  const store = new ChatFileStore(f.config, pino({ level: "silent" }), localFileService, f.dir); await store.init();
  const original = await store.importBuffer({ buffer: Buffer.from("original"), sourceName: "group-file.txt", kind: "file", origin: "group_file_download", sourceContext: { groupId: "123" } });
  const context = { config: f.config, relationship: "known", currentUser: null, lastMessage: actor, localFileService, temporaryWorkspaceService: f.service, chatFileStore: store } as unknown as BuiltinToolContext;
  const invoke = async (name: string, args: unknown) => {
    const handler = localFileToolHandlers[name] ?? chatFileToolHandlers[name] ?? temporaryWorkspaceToolHandlers[name];
    return parseJsonToolResult<any>(await handler!(createFunctionToolCall(name), args, context));
  };
  await invoke("asset_export_to_filesystem", { workspace_id: w.resource_id, asset_ref: original.fileRef, to_path: "copy.txt" });
  await invoke("filesystem_patch", { workspace_id: w.resource_id, path: "copy.txt", old_text: "original", new_text: "edited" });
  const result = await invoke("filesystem_read", { workspace_id: w.resource_id, path: "copy.txt" });
  assert.equal(result.workspace_id, w.resource_id); assert.match(result.content_preview, /edited/);
  const listed = await invoke("filesystem_list", { workspace_id: w.resource_id, path: "copy.txt" });
  assert.equal(listed.handle.selector.workspace_id, w.resource_id);
  for (const action of listed.next_actions ?? []) assert.equal(action.args.workspace_id, w.resource_id);
  assert.equal(await readFile(await store.resolveAbsolutePath(original.fileId), "utf8"), "original");
  const exported = await invoke("workspace_export", { workspace_id: w.resource_id, path: "copy.txt" });
  await f.service.close(w.resource_id, actor);
  assert.equal(await readFile(await store.resolveAbsolutePath(exported.file_id ?? exported.asset_handle.asset_id), "utf8"), "edited");
  await invoke("filesystem_write", { path: join(f.dir, "explicit.txt"), content: "explicit" });
  assert.equal(await readFile(join(f.dir, "explicit.txt"), "utf8"), "explicit");
  await assert.rejects(invoke("filesystem_read", { workspace_id: "", path: join(f.dir, "explicit.txt") }), /不能为空/);
});

test("non-owner tools expose workspaces and resource lists remain actor-scoped", async (t) => {
  const f = await fixture(t); const own = await f.service.create(actor); await f.service.create({ ...actor, userId: "other" });
  const tools = getBuiltinTools("known", f.config);
  assert.ok(tools.some((tool) => tool.function.name === "workspace_create"));
  for (const tool of tools.filter((tool) => tool.function.name.startsWith("filesystem_"))) assert.ok((tool.function.parameters.properties as any).workspace_id);
  const result = parseJsonToolResult<any>(await resourceToolHandlers.list_live_resources!(createFunctionToolCall("list_live_resources"), { type: "workspace" }, { config: f.config, lastMessage: actor, temporaryWorkspaceService: f.service } as BuiltinToolContext));
  assert.deepEqual(result.live_resources.map((item: any) => item.resource_id), [own.resource_id]);
});

test("workspace API previews text safely and blocks expired files and paths", async (t) => {
  const f = await fixture(t); const w = await f.service.create(actor);
  await f.service.withFiles(w.resource_id, actor, async (files) => { await files.writeFile("a.html", "<script>alert(1)</script>", "create"); });
  const app = Fastify(); registerTemporaryWorkspaceRoutes(app, f.service); t.after(() => app.close());
  const base = `/api/workspaces/${w.resource_id}`;
  const listing = await app.inject({ url: `${base}/files` }); assert.equal(listing.statusCode, 200); assert.equal(listing.json().items[0].name, "a.html"); assert.equal(listing.json().root, undefined);
  const text = await app.inject({ url: `${base}/text?path=a.html` }); assert.equal(text.json().content, "<script>alert(1)</script>");
  const content = await app.inject({ url: `${base}/content?path=a.html` }); assert.match(String(content.headers["content-disposition"]), /attachment/); assert.match(String(content.headers["content-security-policy"]), /sandbox/);
  const range = await app.inject({ url: `${base}/content?path=a.html`, headers: { range: "bytes=0-6" } });
  assert.equal(range.statusCode, 206); assert.equal(range.body, "<script");
  assert.equal((await app.inject({ url: `${base}/content?path=a.html`, headers: { range: "bytes=99999-" } })).statusCode, 416);
  assert.equal((await app.inject({ url: `${base}/text?path=../metadata.json` })).statusCode, 400);
  f.advance(86400000);
  assert.equal((await app.inject({ url: `${base}/files` })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/workspaces" })).json().workspaces[0].status, "expired");
});


test("compacted filesystem observations retain workspace identity and scoped refetch instructions", () => {
  const policy = localFileToolDescriptors.find((tool) => tool.definition.function.name === "filesystem_read")!.resultObservation!;
  const parsedContent = { path: "src/a.txt", startLine: 1, endLine: 1, content: "hello" };
  const context = { toolName: "filesystem_read", toolCallId: "read", args: { workspace_id: "ws_example", path: "src/a.txt" }, rawContent: JSON.stringify(parsedContent), parsedContent, rawLength: 80, estimatedTokens: 20 };
  const resource = policy.resource!(context);
  assert.equal(resource?.id, "ws_example:src/a.txt");
  const refetchHint = policy.refetchHint!({ ...context, resource });
  assert.match(refetchHint!, /path=src\/a.txt/);
  assert.match(refetchHint!, /workspace_id="ws_example"/);
  const compacted = policy.compactors!.filesystem_read_summary!({ ...context, resource, refetchHint, pinned: false });
  assert.equal(JSON.parse(compacted.replayContent).workspace_id, "ws_example");
  assert.match(compacted.summary, /ws_example/);
});

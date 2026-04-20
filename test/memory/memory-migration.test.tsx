import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMemoryDataDir } from "../../src/memory/migration.ts";

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

  test("memory migration rewrites legacy data files into the new structure and emits a review report", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-memory-migration-test-"));
    try {
      await writeFile(join(dataDir, "users.json"), JSON.stringify([
        {
          userId: "10001",
          nickname: "老王",
          sharedContext: "现实朋友",
          profileSummary: "做事很快。\n经常先给结论。喜欢把问题拆开处理。",
          memories: [
            { id: "mem_1", title: "称呼", content: "希望你叫我老王", updatedAt: 1 },
            { id: "mem_2", title: "用户称呼偏好", content: "希望你叫我老王", updatedAt: 2 },
            { id: "mem_3", title: "交流边界", content: "不要替我做决定", updatedAt: 3 }
          ],
          createdAt: 1
        }
      ], null, 2));
      await writeFile(join(dataDir, "persona.json"), JSON.stringify({
        identity: "可靠搭档",
        speakingStyle: "直接一点",
        roleplayRequirements: "保持角色一致。",
        outputFormatRequirements: "默认先给结论再展开。",
        memories: [
          { id: "pm_1", title: "输出习惯", content: "所有任务默认先给结论再展开。", updatedAt: 4 }
        ]
      }, null, 2));
      await writeFile(join(dataDir, "global-memories.json"), JSON.stringify([
        { id: "gr_1", title: "输出顺序", content: "先给结论再展开。", updatedAt: 5 },
        { id: "gr_2", title: "默认输出顺序", content: "默认先给结论再展开。", updatedAt: 6 }
      ], null, 2));
      await writeFile(join(dataDir, "operation-notes.json"), JSON.stringify([
        { id: "tr_1", title: "网页登录处理", content: "只有遇到网页登录任务时才读取站点凭据。", toolsetIds: ["web_research"], source: "owner", updatedAt: 7 },
        { id: "tr_2", title: "网页登录规则", content: "只有遇到网页登录任务时才读取站点凭据。", toolsetIds: ["web_research"], source: "owner", updatedAt: 8 }
      ], null, 2));

      const report = await migrateMemoryDataDir({ dataDir });

      const users = await readJson(join(dataDir, "users.json")) as Array<Record<string, unknown>>;
      const persona = await readJson(join(dataDir, "persona.json")) as Record<string, unknown>;
      const globalRules = await readJson(join(dataDir, "global-rules.json")) as Array<Record<string, unknown>>;
      const toolsetRules = await readJson(join(dataDir, "toolset-rules.json")) as Array<Record<string, unknown>>;
      const reportFile = await readJson(join(dataDir, "memory-migration-report.json")) as Record<string, unknown>;

      assert.equal(users.length, 1);
      assert.equal(users[0]?.preferredAddress, "老王");
      assert.equal(users[0]?.relationshipNote, "现实朋友");
      assert.match(String(users[0]?.profileSummary ?? ""), /做事很快；经常先给结论/);
      assert.equal((users[0]?.memories as Array<unknown>).length, 2);

      assert.equal(persona.role, "可靠搭档");
      assert.equal(persona.speechStyle, "直接一点");
      assert.equal(persona.rules, "保持角色一致。");

      assert.ok(globalRules.length >= 2);
      assert.equal(toolsetRules.length, 1);
      assert.ok(report.duplicates.length >= 2);
      assert.ok(report.scopeFindings.length >= 1);
      assert.equal(reportFile.filesRemoved instanceof Array, true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

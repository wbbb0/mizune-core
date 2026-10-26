import { readFile, writeFile, copyFile, rename, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { migrateRoutingPresetContextBudgets } from "../src/config/contextBudgetMigration.ts";

const path = resolve(process.argv[2] ?? "config/llm.routing-presets.yml");
const original = await readFile(path, "utf8");
const document = YAML.parseDocument(original);
if (document.errors.length > 0) throw new Error("预设 YAML 无效，未修改文件");
const raw = document.toJS();
const migrated = migrateRoutingPresetContextBudgets(raw);
if (JSON.stringify(raw) === JSON.stringify(migrated)) {
  console.log("预设已使用总上下文字段，无需迁移。");
} else {
  for (const name of Object.keys(raw)) {
    if (!document.hasIn([name, "tokenLimits", "triggerTokens"])) continue;
    if (!document.hasIn([name, "tokenLimits", "contextTokens"])) {
      document.setIn([name, "tokenLimits", "contextTokens"], document.getIn([name, "tokenLimits", "triggerTokens"]));
    }
    document.deleteIn([name, "tokenLimits", "triggerTokens"]);
  }
  const backup = `${path}.before-context-budget-${Date.now()}.bak`;
  await copyFile(path, backup, constants.COPYFILE_EXCL);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, String(document), { mode: (await stat(path)).mode, flag: "wx" });
  await rename(temporary, path);
  console.log(`已迁移预设；原文件备份：${backup}`);
}

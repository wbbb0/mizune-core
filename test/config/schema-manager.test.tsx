import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildUiTree,
  ConfigParseError,
  createSchemaTemplate,
  exportSchemaMeta,
  loadAndDumpConfig,
  loadConfig,
  parseConfig,
  s,
  writeConfigFile
} from "../../src/data/schema/index.ts";
import { runCase, withTempDir } from "../helpers/config-test-support.tsx";

const appSchema = s.object({
  server: s.object({
    host: s.string()
      .default("127.0.0.1")
      .describe("监听地址"),
    port: s.number()
      .int()
      .min(1)
      .max(65535)
      .default(8080)
      .describe("监听端口"),
    debug: s.boolean()
      .default(false)
      .describe("是否开启调试模式")
  }).describe("服务端配置"),
  database: s.object({
    url: s.string()
      .nonempty()
      .describe("数据库连接串"),
    poolSize: s.number()
      .int()
      .min(1)
      .default(10)
      .describe("连接池大小")
  }).describe("数据库配置"),
  features: s.record(
    s.string().nonempty().describe("功能名"),
    s.boolean().describe("是否启用")
  )
    .default({})
    .describe("动态功能开关，可增删"),
  admins: s.array(
    s.object({
      name: s.string().nonempty().describe("管理员名称"),
      email: s.string().nonempty().describe("管理员邮箱")
    }).describe("管理员项")
  )
    .default([])
    .describe("管理员列表，可增删，数组覆盖策略为 replace"),
  logLevel: s.enum(["debug", "info", "warn", "error"])
    .default("info")
    .describe("日志级别")
}).strict();

async function main() {
  await runCase("parseConfig applies defaults and keeps inferred structure", async () => {
    const config = parseConfig(appSchema, {
      server: {
        port: 9000
      },
      database: {
        url: "postgres://localhost/demo"
      }
    });

    assert.equal(config.server.host, "127.0.0.1");
    assert.equal(config.server.port, 9000);
    assert.equal(config.server.debug, false);
    assert.equal(config.database.poolSize, 10);
    assert.deepEqual(config.features, {});
    assert.deepEqual(config.admins, []);
    assert.equal(config.logLevel, "info");
  });

  await runCase("strict object schema rejects unknown keys", async () => {
    assert.throws(
      () => parseConfig(appSchema, {
        server: {
          port: 8080
        },
        database: {
          url: "postgres://localhost/demo"
        },
        extra: true
      }),
      (error) => error instanceof ConfigParseError && /extra: unknown key/.test(error.message)
    );
  });

  await runCase("loadConfig merges layers and replaces arrays", async () => {
    await withTempDir("llm-bot-config-schema-load", async (dir: string) => {
      const baseFile = join(dir, "app.yml");
      const envFile = join(dir, "app.prod.yml");
      const localFile = join(dir, "app.local.yml");
      await writeFile(baseFile, [
        "server:",
        "  host: 0.0.0.0",
        "database:",
        "  url: postgres://localhost/base",
        "features:",
        "  alpha: true",
        "admins:",
        "  - name: Base",
        "    email: base@example.com"
      ].join("\n"));
      await writeFile(envFile, [
        "server:",
        "  port: 9100",
        "features:",
        "  beta: false"
      ].join("\n"));
      await writeFile(localFile, [
        "admins:",
        "  - name: Local",
        "    email: local@example.com",
        "logLevel: warn"
      ].join("\n"));

      const config = await loadConfig({
        schema: appSchema,
        layers: [baseFile, envFile, { file: localFile, optional: true }]
      });

      assert.equal(config.server.host, "0.0.0.0");
      assert.equal(config.server.port, 9100);
      assert.equal(config.database.url, "postgres://localhost/base");
      assert.deepEqual(config.features, {
        alpha: true,
        beta: false
      });
      assert.deepEqual(config.admins, [
        {
          name: "Local",
          email: "local@example.com"
        }
      ]);
      assert.equal(config.logLevel, "warn");
    });
  });

  await runCase("exportSchemaMeta and buildUiTree expose schema structure", async () => {
    const meta = exportSchemaMeta(appSchema);
    const uiTree = buildUiTree(appSchema);

    assert.equal(meta.kind, "object");
    assert.equal((meta as any).unknownKeys, "strict");
    assert.equal((meta as any).fields.server.kind, "object");
    assert.equal((meta as any).fields.logLevel.kind, "enum");
    assert.deepEqual((meta as any).fields.logLevel.values, ["debug", "info", "warn", "error"]);

    assert.equal(uiTree.kind, "group");
    assert.equal((uiTree as any).children.server.kind, "group");
    assert.equal((uiTree as any).children.features.kind, "record");
    assert.equal((uiTree as any).children.admins.kind, "array");
  });

  await runCase("createSchemaTemplate builds an empty object from nested defaults", async () => {
    const template = createSchemaTemplate(appSchema);

    assert.deepEqual(template, {
      server: {
        host: "127.0.0.1",
        port: 8080,
        debug: false
      },
      database: {
        poolSize: 10
      },
      features: {},
      admins: [],
      logLevel: "info"
    });
  });

  await runCase("loadAndDumpConfig writes parsed config in requested format", async () => {
    await withTempDir("llm-bot-config-schema-dump", async (dir: string) => {
      const sourceFile = join(dir, "app.yml");
      const outputYaml = join(dir, "generated-config.yml");
      const outputJson = join(dir, "generated-config.json");
      await writeFile(sourceFile, [
        "server:",
        "  port: 9200",
        "database:",
        "  url: postgres://localhost/dump"
      ].join("\n"));

      const config = await loadAndDumpConfig({
        schema: appSchema,
        layers: [sourceFile],
        outputPath: outputYaml,
        outputFormat: "yaml"
      });

      assert.equal(config.server.port, 9200);
      const yamlOutput = await readFile(outputYaml, "utf8");
      assert.match(yamlOutput, /host: 127\.0\.0\.1/);
      assert.match(yamlOutput, /port: 9200/);

      await writeConfigFile(outputJson, config, {
        format: "json",
        prettyJsonSpaces: 2
      });
      const jsonOutput = await readFile(outputJson, "utf8");
      const parsed = JSON.parse(jsonOutput);
      assert.equal(parsed.database.url, "postgres://localhost/dump");
      assert.equal(parsed.logLevel, "info");
    });
  });
}

await main();

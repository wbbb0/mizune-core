import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { registerWebuiStaticRoutes } from "../../src/internalApi/webuiStatic.ts";
import { createTempDir } from "../helpers/temp-paths.ts";

test("registerWebuiStaticRoutes serves precompressed assets when the client accepts gzip", async () => {
  const distDir = createTempDir("llm-bot-webui-static");
  const assetsDir = join(distDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const scriptContent = "console.log('served from gzip');";
  writeFileSync(join(assetsDir, "index.js"), scriptContent, "utf8");
  writeFileSync(join(assetsDir, "index.js.gz"), gzipSync(scriptContent));
  const htmlContent = "<!doctype html><title>webui</title>";
  writeFileSync(join(distDir, "index.html"), htmlContent, "utf8");
  writeFileSync(join(distDir, "index.html.gz"), gzipSync(htmlContent));

  const app = Fastify({ logger: false });
  await registerWebuiStaticRoutes(app, distDir);
  await app.ready();

  const gzipResponse = await app.inject({
    method: "GET",
    url: "/webui/assets/index.js",
    headers: {
      "accept-encoding": "gzip, deflate"
    }
  });

  assert.equal(gzipResponse.statusCode, 200);
  assert.equal(gzipResponse.headers["content-encoding"], "gzip");
  assert.match(String(gzipResponse.headers["vary"] ?? ""), /accept-encoding/i);
  assert.equal(gunzipSync(gzipResponse.rawPayload).toString("utf8"), scriptContent);

  const plainResponse = await app.inject({
    method: "GET",
    url: "/webui/assets/index.js"
  });

  assert.equal(plainResponse.statusCode, 200);
  assert.equal(plainResponse.headers["content-encoding"], undefined);
  assert.equal(plainResponse.body, scriptContent);

  const spaFallbackResponse = await app.inject({
    method: "GET",
    url: "/webui/sessions",
    headers: {
      "accept-encoding": "gzip"
    }
  });

  assert.equal(spaFallbackResponse.statusCode, 200);
  assert.equal(spaFallbackResponse.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(spaFallbackResponse.rawPayload).toString("utf8"), htmlContent);

  await app.close();
});

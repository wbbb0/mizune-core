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
  const assetsDir = createTempDir("llm-bot-webui-assets");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(join(distDir, "assets"), { recursive: true });

  const scriptContent = "console.log('served from gzip');";
  writeFileSync(join(assetsDir, "index.js"), scriptContent, "utf8");
  writeFileSync(join(assetsDir, "index.js.gz"), gzipSync(scriptContent));
  writeFileSync(join(distDir, "assets", "index.js"), "console.log('stale release-local asset');", "utf8");
  const htmlContent = "<!doctype html><title>webui</title>";
  writeFileSync(join(distDir, "index.html"), htmlContent, "utf8");
  writeFileSync(join(distDir, "index.html.gz"), gzipSync(htmlContent));

  const app = Fastify({ logger: false });
  await registerWebuiStaticRoutes(app, distDir, assetsDir);
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

  const missingAssetResponse = await app.inject({
    method: "GET",
    url: "/webui/assets/missing.js"
  });
  assert.equal(missingAssetResponse.statusCode, 404);
  assert.doesNotMatch(String(missingAssetResponse.headers["content-type"] ?? ""), /text\/html/);

  const unknownWebuiResponse = await app.inject({ method: "GET", url: "/webui/sessions" });
  assert.equal(unknownWebuiResponse.statusCode, 404);

  const rootRedirectResponse = await app.inject({ method: "GET", url: "/" });
  assert.equal(rootRedirectResponse.statusCode, 302);
  assert.equal(rootRedirectResponse.headers.location, "/webui/");

  const baseRedirectResponse = await app.inject({ method: "GET", url: "/webui" });
  assert.equal(baseRedirectResponse.statusCode, 308);
  assert.equal(baseRedirectResponse.headers.location, "/webui/");

  assert.equal(gzipResponse.headers["cache-control"], "public, max-age=31536000, immutable");

  const htmlResponse = await app.inject({ method: "GET", url: "/webui/" });
  assert.equal(htmlResponse.statusCode, 200);
  assert.equal(htmlResponse.headers["cache-control"], "no-cache");

  await app.close();
});

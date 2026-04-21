import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createTempDir } from "../../helpers/temp-paths.ts";
import { writeGzipPrecompressedAssets } from "../../../webui/build/gzipPrecompression.ts";

test("writeGzipPrecompressedAssets creates .gz copies for compressible web assets only", async () => {
  const outputDir = createTempDir("llm-bot-webui-gzip");
  const assetsDir = join(outputDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const scriptContent = "console.log('hello from gzip test');\n".repeat(8);
  writeFileSync(join(assetsDir, "app.js"), scriptContent, "utf8");
  writeFileSync(join(assetsDir, "icon.svg"), "<svg></svg>", "utf8");
  writeFileSync(join(assetsDir, "photo.png"), Buffer.from([0, 1, 2, 3]));

  await writeGzipPrecompressedAssets(outputDir);

  assert.equal(existsSync(join(assetsDir, "app.js.gz")), true);
  assert.equal(existsSync(join(assetsDir, "icon.svg.gz")), true);
  assert.equal(existsSync(join(assetsDir, "photo.png.gz")), false);
  assert.equal(
    gunzipSync(readFileSync(join(assetsDir, "app.js.gz"))).toString("utf8"),
    scriptContent
  );
});

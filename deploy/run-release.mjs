import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseDir = dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8"));

if (typeof metadata.releaseId !== "string" || metadata.releaseId.length === 0) {
  throw new Error(`Invalid release metadata in ${join(releaseDir, "release.json")}`);
}

process.env.LLM_BOT_RELEASE_ID = metadata.releaseId;
await import(pathToFileURL(join(releaseDir, "dist/index.mjs")).href);

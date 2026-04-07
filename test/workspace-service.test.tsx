import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createTestAppConfig } from "./helpers/config-fixtures.tsx";
import { runCase } from "./helpers/config-test-support.tsx";
import { WorkspaceService } from "../src/services/workspace/workspaceService.ts";

await runCase("workspace service rejects binary image files in text preview", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-service-"));
  try {
    const config = createTestAppConfig({
      workspace: {
        enabled: true,
        root: "data",
        maxPatchFileBytes: 1024 * 1024
      }
    });
    const service = new WorkspaceService(config, rootDir);
    await service.init();

    await writeFile(join(rootDir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    await assert.rejects(
      service.readFile("photo.png"),
      /Workspace file is not a text file: photo\.png/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

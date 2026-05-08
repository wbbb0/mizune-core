import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

import { LocalFileService } from "../../src/services/workspace/localFileService.ts";

test("workspace service rejects binary image files in text preview", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-service-"));
  try {
    const config = createTestAppConfig({
      localFiles: {
        enabled: true,
        root: "data",
        maxPatchFileBytes: 1024 * 1024
      }
    });
    const service = new LocalFileService(config, rootDir);
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

test("workspace service rejects absolute local file paths", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-service-"));
  try {
    const config = createTestAppConfig({
      localFiles: {
        enabled: true,
        root: "data"
      }
    });
    const service = new LocalFileService(config, rootDir);
    await service.init();

    assert.throws(
      () => service.resolvePath(join(rootDir, "outside.txt")),
      /local file path must be relative to the workspace root/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workspace service rejects paths escaping through symlink directories", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-service-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "llm-bot-workspace-outside-"));
  try {
    const config = createTestAppConfig({
      localFiles: {
        enabled: true,
        root: "data"
      }
    });
    const service = new LocalFileService(config, rootDir);
    await service.init();
    await writeFile(join(outsideDir, "secret.txt"), "secret", "utf8");
    await symlink(outsideDir, join(rootDir, "linked-outside"), "dir");

    await assert.rejects(
      service.readFile("linked-outside/secret.txt"),
      /local file path cannot escape the root directory/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataRegistryService } from "../../src/internalApi/application/dataRegistryService.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";

function createRegistryService(dataDir: string) {
  const persona = createEmptyPersona();
  const whitelistRows: Array<{ targetType: "user" | "group"; targetId: string; createdAtMs: number }> = [];
  return createDataRegistryService({
    config: { dataDir },
    personaStore: {
      async get() {
        return persona;
      },
      async write(nextPersona) {
        Object.assign(persona, nextPersona);
      }
    },
    whitelistStore: {
      async listEntries() {
        return [...whitelistRows];
      },
      async upsertEntry(targetType, targetId) {
        const row = { targetType, targetId, createdAtMs: Date.now() };
        whitelistRows.push(row);
        return row;
      },
      async deleteEntry(targetType, targetId) {
        const index = whitelistRows.findIndex((row) => row.targetType === targetType && row.targetId === targetId);
        if (index >= 0) {
          whitelistRows.splice(index, 1);
        }
      }
    }
  });
}

test("DataRegistryService exposes initial file and directory resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    await mkdir(join(dataDir, "sessions"), { recursive: true });
    await mkdir(join(dataDir, "workspace"), { recursive: true });
    await writeFile(join(dataDir, "audio-files.json"), JSON.stringify({ files: ["a"] }), "utf8");
    await writeFile(join(dataDir, "sessions", "private%3Au1.json"), JSON.stringify({ id: "private:u1" }), "utf8");

    const service = createRegistryService(dataDir);

    const listed = await service.listResources();
    assert.deepEqual(listed.resources.map((resource) => resource.key), [
      "audio_files",
      "image_files",
      "persona",
      "sessions",
      "whitelist",
      "workspace_files"
    ]);
    assert.equal(listed.resources.find((resource) => resource.key === "audio_files")?.shape, "file");
    assert.equal(listed.resources.find((resource) => resource.key === "sessions")?.shape, "directory");

    assert.deepEqual(await service.getResource("audio_files"), {
      resource: {
        key: "audio_files",
        title: "Audio Files",
        shape: "file",
        editable: false,
        durability: "derived",
        storage: {
          kind: "file",
          path: join(dataDir, "audio-files.json")
        },
        value: { files: ["a"] }
      }
    });

    const sessions = await service.getResource("sessions") as {
      resource: {
        items: Array<{ key: string; title: string }>;
      };
    };
    assert.equal(sessions.resource.items.length, 1);
    assert.equal(sessions.resource.items[0]?.key, "private%3Au1.json");
    assert.equal(sessions.resource.items[0]?.title, "private:u1");

    const item = await service.getDirectoryItem("sessions", "private%3Au1.json");
    assert.deepEqual((item as { item: { value: unknown } }).item.value, { id: "private:u1" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService rejects row and export operations for initial file resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    await assert.rejects(
      service.listRows("audio_files"),
      /Data resource does not contain rows: audio_files/u
    );
    await assert.rejects(
      service.exportResource("audio_files"),
      /Data resource does not support export: audio_files/u
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes editable persona singleton and whitelist collection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const persona = await service.getResource("persona") as {
      resource: {
        shape: string;
        editable: boolean;
        value: unknown;
        uiTree?: unknown;
      };
    };
    assert.equal(persona.resource.shape, "singleton");
    assert.equal(persona.resource.editable, true);
    assert.ok(persona.resource.uiTree);

    await service.patchSingleton("persona", {
      name: "Bot",
      temperament: "calm",
      speakingStyle: "clear",
      globalTraits: "",
      generalPreferences: ""
    });
    assert.deepEqual((await service.getResource("persona") as { resource: { value: unknown } }).resource.value, {
      name: "Bot",
      temperament: "calm",
      speakingStyle: "clear",
      globalTraits: "",
      generalPreferences: ""
    });

    const created = await service.createRow("whitelist", {
      targetType: "user",
      targetId: "10001"
    }) as { row: { id: string; targetType: string; targetId: string } };
    assert.equal(created.row.targetType, "user");
    assert.equal(created.row.targetId, "10001");

    const rows = await service.listRows("whitelist", { limit: 10 });
    assert.equal(rows.total, 1);
    assert.deepEqual(rows.rows.map((row) => (row as { targetId: string }).targetId), ["10001"]);

    await service.deleteRow("whitelist", created.row.id);
    assert.equal((await service.listRows("whitelist")).total, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

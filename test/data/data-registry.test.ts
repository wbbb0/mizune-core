import test from "node:test";
import assert from "node:assert/strict";
import { DataRegistry, type DataResourceDefinition } from "../../src/data/registry/index.ts";

function createReadonlySingleton(input?: Partial<DataResourceDefinition>): DataResourceDefinition {
  return {
    key: "settings",
    title: "Settings",
    shape: "singleton",
    accessMode: "readonly",
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "settings",
      tables: ["settings"]
    },
    adapter: {
      get: async () => ({ enabled: true })
    },
    ...input
  };
}

test("DataRegistry lists resources in stable key order without exposing adapters", () => {
  const registry = new DataRegistry();
  registry.register(createReadonlySingleton({ key: "zeta", title: "Zeta" }));
  registry.register(createReadonlySingleton({ key: "alpha", title: "Alpha" }));

  const result = registry.listResources();
  assert.deepEqual(result.resources.map((resource) => resource.key), ["alpha", "zeta"]);
  assert.equal("adapter" in result.resources[0]!, false);
  assert.equal(result.resources[0]?.shape, "singleton");
  assert.equal(result.resources[0]?.accessMode, "readonly");
  assert.equal(result.resources[0]?.rowOperations, undefined);
});

test("DataRegistry rejects duplicate resource keys", () => {
  const registry = new DataRegistry();
  registry.register(createReadonlySingleton());
  assert.throws(
    () => registry.register(createReadonlySingleton()),
    /Duplicate data resource: settings/u
  );
});

test("DataRegistry blocks writes to readonly singleton resources", async () => {
  const registry = new DataRegistry();
  registry.register(createReadonlySingleton());

  await assert.rejects(
    registry.patchSingleton("settings", { enabled: false }),
    /Data resource is not editable: settings/u
  );
});

test("DataRegistry routes collection row operations through row adapters", async () => {
  const registry = new DataRegistry();
  const patched: unknown[] = [];
  registry.register({
    key: "items",
    title: "Items",
    shape: "collection",
    accessMode: "editable",
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "items",
      tables: ["items"]
    },
    rowIdentity: {
      fields: ["id"],
      encode: "single"
    },
    adapter: {
      listRows: async (input) => ({
        rows: [{ id: "item-1" }],
        offset: input.offset ?? 0,
        limit: input.limit ?? 100,
        total: 1
      }),
      getRow: async (rowId) => rowId === "item-1" ? { id: "item-1" } : null,
      patchRow: async (rowId, input) => {
        patched.push({ rowId, input });
        return { id: rowId, input };
      }
    }
  });

  assert.deepEqual(await registry.listRows("items", { limit: 10 }), {
    rows: [{ id: "item-1" }],
    offset: 0,
    limit: 10,
    total: 1
  });
  const resource = await registry.getResource("items") as {
    resource: {
      rowOperations: unknown;
    };
  };
  assert.deepEqual(resource.resource.rowOperations, {
    get: true,
    create: false,
    patch: true,
    delete: false
  });
  assert.deepEqual(await registry.getRow("items", "item-1"), {
    row: { id: "item-1" }
  });
  assert.deepEqual(await registry.patchRow("items", "item-1", {
    patch: { label: "next" },
    revision: 1
  }), {
    row: {
      id: "item-1",
      input: {
        patch: { label: "next" },
        revision: 1
      }
    }
  });
  assert.deepEqual(patched, [{
    rowId: "item-1",
    input: {
      patch: { label: "next" },
      revision: 1
    }
  }]);
});

test("DataRegistry allows delete-only collection resources", async () => {
  const registry = new DataRegistry();
  const deleted: string[] = [];
  registry.register({
    key: "items",
    title: "Items",
    shape: "collection",
    accessMode: "deletable",
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "items",
      tables: ["items"]
    },
    rowIdentity: {
      fields: ["id"],
      encode: "single"
    },
    adapter: {
      listRows: async () => ({ rows: [{ id: "item-1" }], offset: 0, limit: 100, total: 1 }),
      deleteRow: async (rowId) => {
        deleted.push(rowId);
      }
    }
  });

  const resource = await registry.getResource("items") as {
    resource: {
      accessMode: string;
      rowOperations: unknown;
    };
  };
  assert.equal(resource.resource.accessMode, "deletable");
  assert.deepEqual(resource.resource.rowOperations, {
    get: false,
    create: false,
    patch: false,
    delete: true
  });
  await assert.rejects(
    registry.patchRow("items", "item-1", { patch: { label: "next" } }),
    /Data resource does not allow editing: items/u
  );
  assert.deepEqual(await registry.deleteRow("items", "item-1"), { ok: true });
  assert.deepEqual(deleted, ["item-1"]);
});

import type {
  CollectionDataResourceAdapter,
  DataResourceDefinition,
  DataResourceListRowsInput,
  DataResourceRowPatchInput,
  DataResourceRowsResult,
  DataResourceSummary,
  DirectoryDataResourceAdapter,
  FileDataResourceAdapter,
  SingletonDataResourceAdapter
} from "./types.ts";

export class DataRegistry {
  private readonly resources = new Map<string, DataResourceDefinition>();

  register(definition: DataResourceDefinition): void {
    if (this.resources.has(definition.key)) {
      throw new Error(`Duplicate data resource: ${definition.key}`);
    }
    this.resources.set(definition.key, definition);
  }

  listResources(): { resources: DataResourceSummary[] } {
    return {
      resources: Array.from(this.resources.values())
        .map((definition) => toSummary(definition))
        .sort((left, right) => left.key.localeCompare(right.key))
    };
  }

  getResourceDefinition(resourceKey: string): DataResourceDefinition {
    const definition = this.resources.get(resourceKey);
    if (!definition) {
      throw new Error(`Unknown data resource: ${resourceKey}`);
    }
    return definition;
  }

  async getResource(resourceKey: string): Promise<unknown> {
    const definition = this.getResourceDefinition(resourceKey);
    const summary = toSummary(definition);
    if (definition.shape === "singleton") {
      return {
        resource: {
          ...summary,
          value: await asSingletonAdapter(definition).get()
        }
      };
    }
    if (definition.shape === "file") {
      return {
        resource: {
          ...summary,
          value: await asFileAdapter(definition).get()
        }
      };
    }
    if (definition.shape === "directory") {
      return {
        resource: {
          ...summary,
          items: await asDirectoryAdapter(definition).listItems()
        }
      };
    }
    return { resource: summary };
  }

  async patchSingleton(resourceKey: string, value: unknown): Promise<unknown> {
    const definition = this.getResourceDefinition(resourceKey);
    if (definition.shape !== "singleton") {
      throw new Error(`Data resource is not a singleton: ${resourceKey}`);
    }
    if (!definition.editable) {
      throw new Error(`Data resource is not editable: ${resourceKey}`);
    }
    const adapter = asSingletonAdapter(definition);
    if (!adapter.patch) {
      throw new Error(`Data resource does not support patch: ${resourceKey}`);
    }
    return {
      resource: toSummary(definition),
      value: await adapter.patch(value)
    };
  }

  async listRows(resourceKey: string, input: DataResourceListRowsInput = {}): Promise<DataResourceRowsResult> {
    const definition = this.getResourceDefinition(resourceKey);
    if (definition.shape !== "collection" && definition.shape !== "log") {
      throw new Error(`Data resource does not contain rows: ${resourceKey}`);
    }
    return asCollectionAdapter(definition).listRows(input);
  }

  async getRow(resourceKey: string, rowId: string): Promise<unknown> {
    const definition = this.getResourceDefinition(resourceKey);
    if (definition.shape !== "collection" && definition.shape !== "log") {
      throw new Error(`Data resource does not contain rows: ${resourceKey}`);
    }
    const adapter = asCollectionAdapter(definition);
    if (!adapter.getRow) {
      throw new Error(`Data resource does not support row lookup: ${resourceKey}`);
    }
    const row = await adapter.getRow(rowId);
    if (row == null) {
      throw new Error(`Unknown data resource row: ${resourceKey}/${rowId}`);
    }
    return { row };
  }

  async createRow(resourceKey: string, value: unknown): Promise<unknown> {
    const definition = this.getEditableCollection(resourceKey);
    const adapter = asCollectionAdapter(definition);
    if (!adapter.createRow) {
      throw new Error(`Data resource does not support row creation: ${resourceKey}`);
    }
    return { row: await adapter.createRow(value) };
  }

  async patchRow(resourceKey: string, rowId: string, input: DataResourceRowPatchInput): Promise<unknown> {
    const definition = this.getEditableCollection(resourceKey);
    const adapter = asCollectionAdapter(definition);
    if (!adapter.patchRow) {
      throw new Error(`Data resource does not support row patch: ${resourceKey}`);
    }
    return { row: await adapter.patchRow(rowId, input) };
  }

  async deleteRow(resourceKey: string, rowId: string): Promise<{ ok: true }> {
    const definition = this.getEditableCollection(resourceKey);
    const adapter = asCollectionAdapter(definition);
    if (!adapter.deleteRow) {
      throw new Error(`Data resource does not support row deletion: ${resourceKey}`);
    }
    await adapter.deleteRow(rowId);
    return { ok: true };
  }

  async exportResource(resourceKey: string): Promise<unknown> {
    const definition = this.getResourceDefinition(resourceKey);
    if (definition.durability === "ephemeral" || definition.export?.enabled !== true) {
      throw new Error(`Data resource does not support export: ${resourceKey}`);
    }
    throw new Error(`Data resource export is not implemented: ${resourceKey}`);
  }

  async getDirectoryItem(resourceKey: string, itemKey: string): Promise<unknown> {
    const definition = this.getResourceDefinition(resourceKey);
    if (definition.shape !== "directory") {
      throw new Error(`Data resource does not contain items: ${resourceKey}`);
    }
    const adapter = asDirectoryAdapter(definition);
    if (!adapter.getItem) {
      throw new Error(`Data resource does not support item lookup: ${resourceKey}`);
    }
    const item = await adapter.getItem(itemKey);
    if (item == null) {
      throw new Error(`Unknown data resource item: ${resourceKey}/${itemKey}`);
    }
    return { item };
  }

  private getEditableCollection(resourceKey: string): DataResourceDefinition {
    const definition = this.getResourceDefinition(resourceKey);
    if (definition.shape !== "collection") {
      throw new Error(`Data resource is not an editable collection: ${resourceKey}`);
    }
    if (!definition.editable) {
      throw new Error(`Data resource is not editable: ${resourceKey}`);
    }
    return definition;
  }
}

function toSummary(definition: DataResourceDefinition): DataResourceSummary {
  const collectionAdapter = definition.shape === "collection" || definition.shape === "log"
    ? asCollectionAdapter(definition)
    : null;
  return {
    key: definition.key,
    title: definition.title,
    ...(definition.description ? { description: definition.description } : {}),
    shape: definition.shape,
    editable: definition.editable,
    durability: definition.durability,
    storage: definition.storage,
    ...(definition.schemaMeta !== undefined ? { schemaMeta: definition.schemaMeta } : {}),
    ...(definition.rowSchemaMeta !== undefined ? { rowSchemaMeta: definition.rowSchemaMeta } : {}),
    ...(definition.uiTree !== undefined ? { uiTree: definition.uiTree } : {}),
    ...(definition.rowUiTree !== undefined ? { rowUiTree: definition.rowUiTree } : {}),
    ...(definition.rowIdentity !== undefined ? { rowIdentity: definition.rowIdentity } : {}),
    ...(collectionAdapter !== null ? {
      rowOperations: {
        get: collectionAdapter.getRow !== undefined,
        create: collectionAdapter.createRow !== undefined,
        patch: collectionAdapter.patchRow !== undefined,
        delete: collectionAdapter.deleteRow !== undefined
      }
    } : {}),
    ...(definition.export !== undefined ? { export: definition.export } : {})
  };
}

function asSingletonAdapter(definition: DataResourceDefinition): SingletonDataResourceAdapter {
  return definition.adapter as SingletonDataResourceAdapter;
}

function asCollectionAdapter(definition: DataResourceDefinition): CollectionDataResourceAdapter {
  return definition.adapter as CollectionDataResourceAdapter;
}

function asFileAdapter(definition: DataResourceDefinition): FileDataResourceAdapter {
  return definition.adapter as FileDataResourceAdapter;
}

function asDirectoryAdapter(definition: DataResourceDefinition): DirectoryDataResourceAdapter {
  return definition.adapter as DirectoryDataResourceAdapter;
}

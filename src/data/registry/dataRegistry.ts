import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dumpConfigString } from "#data/schema/file.ts";
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

export interface DataRegistryOptions {
  dumpDir?: string;
}

export class DataRegistry {
  private readonly resources = new Map<string, DataResourceDefinition>();

  constructor(private readonly options: DataRegistryOptions = {}) {
  }

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
    if (definition.accessMode !== "editable") {
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
    const definition = this.getCollectionWithAccess(resourceKey, "editable");
    const adapter = asCollectionAdapter(definition);
    if (!adapter.createRow) {
      throw new Error(`Data resource does not support row creation: ${resourceKey}`);
    }
    return { row: await adapter.createRow(value) };
  }

  async patchRow(resourceKey: string, rowId: string, input: DataResourceRowPatchInput): Promise<unknown> {
    const definition = this.getCollectionWithAccess(resourceKey, "editable");
    const adapter = asCollectionAdapter(definition);
    if (!adapter.patchRow) {
      throw new Error(`Data resource does not support row patch: ${resourceKey}`);
    }
    return { row: await adapter.patchRow(rowId, input) };
  }

  async deleteRow(resourceKey: string, rowId: string): Promise<{ ok: true }> {
    const definition = this.getCollectionWithAccess(resourceKey, "deletable");
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
    if (!this.options.dumpDir) {
      throw new Error("Data resource export dump directory is not configured");
    }
    const fileName = validateExportFileName(definition.export.fileName);
    const filePath = join(this.options.dumpDir, fileName);
    const value = await buildExportValue(definition);
    const content = dumpExportContent(value, definition.export.format);
    await writeAtomicTextFile(filePath, content);
    return {
      resource: toSummary(definition),
      filePath,
      format: definition.export.format,
      bytes: Buffer.byteLength(content, "utf8")
    };
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

  private getCollectionWithAccess(resourceKey: string, requiredAccess: "deletable" | "editable"): DataResourceDefinition {
    const definition = this.getResourceDefinition(resourceKey);
    if (definition.shape !== "collection") {
      throw new Error(`Data resource is not an editable collection: ${resourceKey}`);
    }
    if (!hasAccess(definition.accessMode, requiredAccess)) {
      throw new Error(`Data resource does not allow ${requiredAccess === "editable" ? "editing" : "deletion"}: ${resourceKey}`);
    }
    return definition;
  }
}

function hasAccess(actual: DataResourceDefinition["accessMode"], required: "deletable" | "editable"): boolean {
  if (required === "editable") {
    return actual === "editable";
  }
  return actual === "deletable" || actual === "editable";
}

async function buildExportValue(definition: DataResourceDefinition): Promise<unknown> {
  if (definition.shape === "singleton") {
    return await asSingletonAdapter(definition).get();
  }
  if (definition.shape === "collection" || definition.shape === "log") {
    const adapter = asCollectionAdapter(definition);
    const rows: unknown[] = [];
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const page = adapter.exportRows
        ? await adapter.exportRows({ offset, limit })
        : await adapter.listRows({ offset, limit });
      rows.push(...page.rows);
      if (page.total !== undefined && rows.length >= page.total) {
        break;
      }
      if (page.rows.length < limit) {
        break;
      }
    }
    return rows;
  }
  if (definition.shape === "file") {
    return await asFileAdapter(definition).get();
  }
  if (definition.shape === "directory") {
    return await asDirectoryAdapter(definition).listItems();
  }
  throw new Error(`Unsupported data resource shape: ${definition.shape}`);
}

function dumpExportContent(value: unknown, format: string): string {
  if (format !== "json" && format !== "yaml") {
    throw new Error(`Data resource export format is not implemented: ${format}`);
  }
  return dumpConfigString(value, {
    format,
    prettyJsonSpaces: 2
  });
}

function validateExportFileName(fileName: string): string {
  if (!fileName.trim() || fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..") {
    throw new Error(`Invalid data resource export file name: ${fileName}`);
  }
  return fileName;
}

async function writeAtomicTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
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
    accessMode: definition.accessMode,
    durability: definition.durability,
    storage: definition.storage,
    ...(definition.schemaMeta !== undefined ? { schemaMeta: definition.schemaMeta } : {}),
    ...(definition.rowSchemaMeta !== undefined ? { rowSchemaMeta: definition.rowSchemaMeta } : {}),
    ...(definition.uiTree !== undefined ? { uiTree: definition.uiTree } : {}),
    ...(definition.rowUiTree !== undefined ? { rowUiTree: definition.rowUiTree } : {}),
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.rowIdentity !== undefined ? { rowIdentity: definition.rowIdentity } : {}),
    ...(definition.navigation !== undefined ? { navigation: definition.navigation } : {}),
    ...(collectionAdapter !== null ? {
      rowOperations: {
        get: collectionAdapter.getRow !== undefined,
        create: definition.accessMode === "editable" && collectionAdapter.createRow !== undefined,
        patch: definition.accessMode === "editable" && collectionAdapter.patchRow !== undefined,
        delete: hasAccess(definition.accessMode, "deletable") && collectionAdapter.deleteRow !== undefined
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

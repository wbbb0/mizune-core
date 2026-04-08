import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readStructuredFileRaw } from "#data/schema/file.ts";
import type { AppConfig } from "#config/config.ts";

type SingleJsonResource = {
  key: string;
  title: string;
  kind: "single_json";
  filePath: string;
};

type DirectoryJsonResource = {
  key: string;
  title: string;
  kind: "directory_json";
  dirPath: string;
};

type DataBrowserResource = SingleJsonResource | DirectoryJsonResource;

export interface DataBrowserService {
  listResources(): Promise<{
    resources: Array<{
      key: string;
      title: string;
      kind: DataBrowserResource["kind"];
    }>;
  }>;
  getResource(resourceKey: string): Promise<unknown>;
  getResourceItem(resourceKey: string, itemKey: string): Promise<unknown>;
}

export function createDataBrowserService(input: {
  config: Pick<AppConfig, "dataDir">;
}): DataBrowserService {
  const resources = buildDataBrowserResourceMap(input.config.dataDir);

  return {
    async listResources() {
      return {
        resources: Array.from(resources.values())
          .map((resource) => ({
            key: resource.key,
            title: resource.title,
            kind: resource.kind
          }))
          .sort((left, right) => left.key.localeCompare(right.key))
      };
    },

    async getResource(resourceKey) {
      const resource = getRequiredResource(resources, resourceKey);
      if (resource.kind === "single_json") {
        return {
          resource: {
            key: resource.key,
            title: resource.title,
            kind: resource.kind,
            path: resource.filePath,
            value: await readOptionalStructuredFile(resource.filePath)
          }
        };
      }

      const items = await listDirectoryItems(resource.dirPath);
      return {
        resource: {
          key: resource.key,
          title: resource.title,
          kind: resource.kind,
          path: resource.dirPath,
          items
        }
      };
    },

    async getResourceItem(resourceKey, itemKey) {
      const resource = getRequiredResource(resources, resourceKey);
      if (resource.kind !== "directory_json") {
        throw new Error(`Resource does not contain items: ${resourceKey}`);
      }

      const items = await listDirectoryItems(resource.dirPath);
      const item = items.find((entry) => entry.key === itemKey);
      if (!item) {
        throw new Error(`Unknown resource item: ${resourceKey}/${itemKey}`);
      }

      return {
        item: {
          resourceKey,
          key: item.key,
          title: item.title,
          path: item.path,
          size: item.size,
          updatedAt: item.updatedAt,
          value: await readOptionalStructuredFile(item.path)
        }
      };
    }
  };
}

function buildDataBrowserResourceMap(dataDir: string): Map<string, DataBrowserResource> {
  const resources: DataBrowserResource[] = [
    {
      key: "image_files",
      title: "Image Files",
      kind: "single_json",
      filePath: join(dataDir, "image-files.json")
    },
    {
      key: "sessions",
      title: "Sessions",
      kind: "directory_json",
      dirPath: join(dataDir, "sessions")
    },
    {
      key: "workspace_files",
      title: "Workspace Files",
      kind: "single_json",
      filePath: join(dataDir, "workspace", "files.json")
    }
  ];

  return new Map(resources.map((resource) => [resource.key, resource]));
}

function getRequiredResource(
  resources: Map<string, DataBrowserResource>,
  resourceKey: string
): DataBrowserResource {
  const resource = resources.get(resourceKey);
  if (!resource) {
    throw new Error(`Unknown data browser resource: ${resourceKey}`);
  }
  return resource;
}

async function readOptionalStructuredFile(filePath: string): Promise<unknown> {
  try {
    return await readStructuredFileRaw(filePath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listDirectoryItems(dirPath: string): Promise<Array<{
  key: string;
  title: string;
  path: string;
  size: number;
  updatedAt: number;
}>> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = join(dirPath, entry.name);
          const fileStat = await stat(filePath);
          return {
            key: entry.name,
            title: decodeURIComponent(entry.name.replace(/\.json$/i, "")),
            path: filePath,
            size: fileStat.size,
            updatedAt: fileStat.mtimeMs
          };
        })
    );

    return files.sort((left, right) => right.updatedAt - left.updatedAt);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

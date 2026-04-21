import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Plugin, ResolvedConfig } from "vite";

const gzipAsync = promisify(gzip);

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest"
]);

async function collectFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(rootDir, fullPath);
    }
    return [fullPath];
  }));
  return nested.flat();
}

function shouldPrecompress(path: string): boolean {
  if (path.endsWith(".gz") || path.endsWith(".br")) {
    return false;
  }
  return COMPRESSIBLE_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function writeGzipPrecompressedAssets(rootDir: string): Promise<void> {
  const files = await collectFiles(rootDir);
  await Promise.all(files.map(async (filePath) => {
    if (!shouldPrecompress(filePath)) {
      return;
    }
    const source = await readFile(filePath);
    const compressed = await gzipAsync(source, { level: 9 });
    await writeFile(`${filePath}.gz`, compressed);
  }));
}

export function createGzipPrecompressionPlugin(): Plugin {
  let config: ResolvedConfig | null = null;

  return {
    name: "llm-bot-webui-gzip-precompression",
    apply: "build",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async closeBundle() {
      if (!config) {
        return;
      }
      await writeGzipPrecompressedAssets(resolve(config.root, config.build.outDir));
    }
  };
}

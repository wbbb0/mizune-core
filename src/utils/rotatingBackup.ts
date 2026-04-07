import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Logger } from "pino";

export async function rotateBackup(params: {
  sourceFilePath: string;
  limit: number;
  logger: Logger;
}): Promise<void> {
  if (params.limit <= 0) {
    return;
  }

  const backupDir = join(dirname(params.sourceFilePath), "backups");
  const sourceBaseName = basename(params.sourceFilePath);
  const nameWithoutExt = sourceBaseName.slice(0, sourceBaseName.length - extname(sourceBaseName).length) || sourceBaseName;
  const backupPrefix = `${nameWithoutExt}.`;

  await mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${backupPrefix}${timestamp}.bak.json`);
  await copyFile(params.sourceFilePath, backupPath);

  const entries = await readdir(backupDir, { withFileTypes: true });
  const matchedFiles = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(backupPrefix) && entry.name.endsWith(".bak.json"))
    .map((entry) => entry.name)
    .sort();

  const overflow = matchedFiles.length - params.limit;
  if (overflow <= 0) {
    return;
  }

  for (const fileName of matchedFiles.slice(0, overflow)) {
    const filePath = join(backupDir, fileName);
    try {
      await rm(filePath);
    } catch (error: unknown) {
      params.logger.warn({ error, filePath }, "backup_rotate_remove_failed");
    }
  }
}

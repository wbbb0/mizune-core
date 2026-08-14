import { readFile } from "node:fs/promises";

export interface LinuxProcessIdentity {
  pid: number;
  startTicks: string;
  bootId: string;
  processGroupId: number;
}

export async function readCurrentBootId(): Promise<string> {
  const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!value) throw new Error("无法读取 Linux boot ID");
  return value;
}

export async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("PID 无效");
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readCurrentBootId()
    ]);
    const closing = stat.lastIndexOf(")");
    if (closing < 0) throw new Error(`进程 stat 格式无效：${pid}`);
    const fieldsAfterCommand = stat.slice(closing + 1).trim().split(/\s+/u);
    const processGroupId = Number(fieldsAfterCommand[2]);
    const startTicks = fieldsAfterCommand[19];
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
      throw new Error(`进程组格式无效：${pid}`);
    }
    if (!startTicks || !/^\d+$/u.test(startTicks)) {
      throw new Error(`进程启动时间格式无效：${pid}`);
    }
    return { pid, startTicks, bootId, processGroupId };
  } catch (error) {
    if (isMissingProcess(error)) return null;
    throw error;
  }
}

export async function matchesLinuxProcessIdentity(input: {
  pid: number;
  startTicks: string;
  bootId: string;
}): Promise<boolean> {
  const current = await readLinuxProcessIdentity(input.pid);
  return current !== null
    && current.startTicks === input.startTicks
    && current.bootId === input.bootId;
}

async function waitForIdentity(pid: number, timeoutMs: number): Promise<LinuxProcessIdentity> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      const identity = await readLinuxProcessIdentity(pid);
      if (identity) return identity;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(
    `无法确认新进程身份：${pid}${lastError == null ? "" : `：${errorMessage(lastError)}`}`
  );
}

export async function readSpawnedProcessIdentity(pid: number): Promise<LinuxProcessIdentity> {
  return waitForIdentity(pid, 1_000);
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT"
      || (error as NodeJS.ErrnoException).code === "ESRCH");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import JSZip from "jszip";
import { isPrivateAddress } from "#vendor/http-download-engine";
import type { LocalFileService } from "./localFileService.ts";

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10000;

export async function extractWorkspaceZip(files: LocalFileService, path: string, toPath: string): Promise<void> {
  const source = files.resolvePath(path);
  if ((await stat(source.absolutePath)).size > MAX_BYTES) throw new Error("压缩文件超过 256 MiB");
  const zip = await JSZip.loadAsync(await readFile(source.absolutePath));
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error("压缩包条目过多");
  await stageDirectory(files, toPath, async (stage) => {
    let total = 0;
    for (const entry of entries) {
      const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
      const clean = posix.normalize(original);
      if (original.includes("\\") || original.includes("\0") || clean.startsWith("/") || clean === ".." || clean.startsWith("../") || /^[a-z]:/i.test(clean)) throw new Error("压缩包路径越界");
      const mode = typeof entry.unixPermissions === "number" ? entry.unixPermissions & 0o170000 : 0;
      if (mode && mode !== 0o100000 && mode !== 0o040000) throw new Error("压缩包不允许链接或特殊文件");
      const destination = join(stage, clean);
      if (entry.dir) { await mkdir(destination, { recursive: true }); continue; }
      const chunks: Buffer[] = [];
      const stream = new Readable({ read() {} }).wrap(entry.nodeStream() as Readable);
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_BYTES) { stream.destroy(); throw new Error("解压后超过 256 MiB"); }
        chunks.push(bytes);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.concat(chunks), { flag: "wx" });
      files.resolvePath(toPath); // Recheck the lease during longer extraction.
    }
  });
}

export async function packWorkspaceZip(files: LocalFileService, paths: string[], toPath: string): Promise<void> {
  const zip = new JSZip();
  let count = 0;
  let total = 0;
  const add = async (path: string): Promise<void> => {
    const target = files.resolvePath(path);
    if (target.relativePath === toPath) throw new Error("压缩目标不能包含在源目录内");
    const info = await stat(target.absolutePath);
    if (++count > MAX_ENTRIES) throw new Error("文件数量超过限制");
    if (info.isDirectory()) {
      if (target.relativePath !== ".") zip.folder(target.relativePath);
      for (const entry of await readdir(target.absolutePath)) await add(posix.join(target.relativePath, entry));
    } else {
      total += info.size;
      if (total > MAX_BYTES) throw new Error("打包文件超过 256 MiB");
      zip.file(target.relativePath, await readFile(target.absolutePath));
    }
  };
  const destination = files.resolvePath(toPath);
  for (const path of paths) await add(path);
  files.resolvePath(toPath);
  await mkdir(dirname(destination.absolutePath), { recursive: true });
  await writeFile(destination.absolutePath, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }), { flag: "wx" });
}

export async function cloneWorkspaceRepository(files: LocalFileService, source: string, toPath: string, expiresAtMs: number): Promise<void> {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443") throw new Error("仅支持不含凭据的公开 HTTPS Git 仓库地址（443 端口）");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error("仅支持公网 Git 仓库");
  const address = addresses[0]!;
  const pinnedAddress = address.family === 6 ? `[${address.address}]` : address.address;
  await stageDirectory(files, toPath, async (stage) => {
    const repo = stage;
    await runGit([
      "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
      "-c", "http.proxy=", "-c", "http.followRedirects=false", "-c", `http.curloptResolve=${url.hostname}:443:${pinnedAddress}`,
      "clone", "--depth=1", "--single-branch", "--no-tags", "--no-recurse-submodules", "--template=", "--", url.href, repo
    ], stage, Math.min(120000, expiresAtMs - Date.now()));
    await rm(join(repo, ".git"), { recursive: true, force: true });
    let count = 0;
    let total = 0;
    const check = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++count > MAX_ENTRIES || (!entry.isFile() && !entry.isDirectory())) throw new Error("仓库含链接、特殊文件或文件数量超限");
        const target = join(path, entry.name);
        if (entry.isDirectory()) await check(target);
        else { total += (await stat(target)).size; if (total > MAX_BYTES) throw new Error("仓库超过 256 MiB"); }
      }
    };
    await check(repo);

  });
}

async function stageDirectory(files: LocalFileService, toPath: string, fill: (stage: string) => Promise<void>): Promise<void> {
  const target = files.resolvePath(toPath);
  if (target.relativePath === ".") throw new Error("请选择新的子目录");
  if (await stat(target.absolutePath).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("目标目录已存在");
  const stage = await mkdtemp(join(dirname(files.rootDir), ".staging-"));
  try {
    await fill(stage);
    files.resolvePath(toPath);
    await mkdir(dirname(target.absolutePath), { recursive: true });
    await rename(stage, target.absolutePath);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function runGit(args: string[], cwd: string, timeout: number): Promise<void> {
  if (timeout <= 0) throw new Error("工作区已过期");
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd, shell: false, detached: true, stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" }
    });
    let stderr = "";
    let stopped = false;
    const stop = () => { stopped = true; if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } } };
    const timer = setTimeout(stop, timeout);
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 && !stopped ? resolve() : reject(new Error(stopped ? "Git 获取超时" : `Git 获取失败：${stderr}`)); });
  });
}

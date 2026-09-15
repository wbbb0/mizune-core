import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  loadProductionDeploymentConfig,
  type ProductionDeploymentConfig,
  type ProductionInstance
} from "./production/deploymentConfig.ts";

interface ReleaseMetadata {
  releaseId: string;
  createdAt: string;
  sourceCommit: string;
  dirty: boolean;
  sourceSnapshotSha256: string;
  dependencyKey: string;
  node: {
    version: string;
    modulesAbi: string;
    platform: string;
    arch: string;
  };
  webAssets: string[];
  legacy: boolean;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface TransactionUnitState {
  name: string;
  healthUrl: string;
  unitName: string;
  unitFileExisted: boolean;
  active: boolean;
  enableState: string;
  mainPid: number;
  healthIdentity: Record<string, unknown> | null;
}

interface BuildingTransaction {
  releaseId: string;
  stage: "building";
}

interface ActivationTransaction {
  releaseId: string;
  stage: "activating" | "rolling_back" | "rollback_failed";
  oldCurrent: string;
  oldPrevious: string | null;
  units: TransactionUnitState[];
}

interface FinishedTransaction {
  releaseId: string;
  stage: "activated" | "complete" | "rolled_back" | "abandoned";
}

type DeploymentTransaction = BuildingTransaction | ActivationTransaction | FinishedTransaction;

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const deployRoot = join(projectRoot, ".deploy");
const releasesRoot = join(deployRoot, "releases");
const dependenciesRoot = join(deployRoot, "dependencies");
const webAssetsRoot = join(deployRoot, "web-assets");
const transactionsRoot = join(deployRoot, "transactions");
const currentLink = join(deployRoot, "current");
const previousLink = join(deployRoot, "previous");
const productionConfigPath = join(projectRoot, "config", "production.yml");
const productionUnitTemplateRelativePath = join("deploy", "llm-bot-production@.service");
const managedUnitMarker = "# Managed by llm-onebot production deployment.";
const sourceIgnoredNames = new Set([".deploy", ".git", ".worktrees", "dist", "node_modules"]);

function run(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  stdio?: "inherit" | "pipe";
} = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio === "inherit" ? "inherit" : "pipe"
  });
  if (result.error) {
    throw result.error;
  }
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} 执行失败 (${status})\n${stderr || stdout}`);
  }
  return { status, stdout, stderr };
}

function output(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function ensureKernelLock(): Promise<never | void> {
  if (process.env.LLM_BOT_DEPLOY_LOCK_HELD === "1") {
    return;
  }
  await mkdir(deployRoot, { recursive: true });
  const child = spawnSync("flock", [
    "--exclusive",
    join(deployRoot, "deploy.lock"),
    process.execPath,
    "--import",
    "tsx",
    scriptPath,
    ...process.argv.slice(2)
  ], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, LLM_BOT_DEPLOY_LOCK_HELD: "1" }
  });
  if (child.error) {
    throw child.error;
  }
  process.exit(child.status ?? 1);
}

function parseArgs(): { allowDirty: boolean; adoptUnit: boolean; skipChecks: boolean } {
  const known = new Set(["--allow-dirty", "--adopt-unit", "--skip-checks"]);
  const unknown = process.argv.slice(2).filter((item) => !known.has(item));
  if (unknown.length > 0) {
    throw new Error(`未知参数: ${unknown.join(", ")}`);
  }
  return {
    allowDirty: process.argv.includes("--allow-dirty"),
    adoptUnit: process.argv.includes("--adopt-unit"),
    skipChecks: process.argv.includes("--skip-checks")
  };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function createReleaseId(commit: string, dirty: boolean): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  return `${timestamp}-${commit.slice(0, 10)}${dirty ? "-dirty" : ""}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.next-${process.pid}`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

async function writeTransaction(path: string, transaction: DeploymentTransaction): Promise<void> {
  await atomicWriteFile(join(path, "state.json"), `${JSON.stringify(transaction, null, 2)}\n`);
}

async function replaceSymlink(linkPath: string, targetPath: string): Promise<void> {
  const temporaryLink = `${linkPath}.next-${process.pid}`;
  await rm(temporaryLink, { force: true });
  await symlink(targetPath, temporaryLink);
  await rename(temporaryLink, linkPath);
}

async function restoreSymlink(linkPath: string, targetPath: string | null): Promise<void> {
  if (targetPath === null) {
    await rm(linkPath, { force: true });
    return;
  }
  await replaceSymlink(linkPath, targetPath);
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      return listFiles(root, path);
    }
    return [relative(root, path)];
  }));
  return nested.flat().sort();
}

async function collectSourceManifest(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const manifest: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (sourceIgnoredNames.has(entry.name)) {
      continue;
    }
    const path = join(current, entry.name);
    const relativePath = relative(root, path);
    if (entry.isDirectory()) {
      manifest.push(...await collectSourceManifest(root, path));
    } else if (entry.isSymbolicLink()) {
      manifest.push(`L ${relativePath} ${await readlink(path)}`);
    } else if (entry.isFile()) {
      manifest.push(`F ${relativePath} ${await sha256File(path)}`);
    }
  }
  return manifest;
}

async function hashSourceSnapshot(root: string): Promise<string> {
  return sha256(`${(await collectSourceManifest(root)).join("\n")}\n`);
}

async function hashLegacyArtifacts(root: string): Promise<string> {
  const manifest: string[] = [];
  for (const relativeRoot of ["dist", "webui/dist"]) {
    for (const file of await listFiles(join(root, relativeRoot))) {
      const path = join(relativeRoot, file);
      manifest.push(`F ${path} ${await sha256File(join(root, path))}`);
    }
  }
  for (const path of ["package-lock.json", "deploy/run-release.mjs"]) {
    manifest.push(`F ${path} ${await sha256File(join(root, path))}`);
  }
  return sha256(`${manifest.sort().join("\n")}\n`);
}

async function copyTrackedWorkingTree(destination: string): Promise<void> {
  const statusBefore = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  const paths = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).stdout
    .split("\0")
    .filter(Boolean);
  await mkdir(destination, { recursive: true });
  for (const path of paths) {
    const sourcePath = join(projectRoot, path);
    if (!await pathExists(sourcePath)) {
      continue;
    }
    const targetPath = join(destination, path);
    const sourceStat = await lstat(sourcePath);
    await mkdir(dirname(targetPath), { recursive: true });
    if (sourceStat.isDirectory()) {
      await cp(sourcePath, targetPath, {
        recursive: true,
        filter(source) {
          const parts = relative(sourcePath, source).split(/[\\/]/);
          return !parts.some((part) => sourceIgnoredNames.has(part));
        }
      });
    } else {
      await cp(sourcePath, targetPath);
    }
  }
  const statusAfter = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  if (statusAfter !== statusBefore) {
    throw new Error("创建工作区快照时源码发生变化，已中止部署");
  }
}

async function linkBuildDependencies(buildRoot: string): Promise<void> {
  await symlink(join(projectRoot, "node_modules"), join(buildRoot, "node_modules"));
  const workbenchDependencies = join(projectRoot, "vendor", "workbench-kit", "node_modules");
  if (await pathExists(workbenchDependencies)) {
    await symlink(
      workbenchDependencies,
      join(buildRoot, "vendor", "workbench-kit", "node_modules")
    );
  }
  const sourceNodeModules = join(projectRoot, "webui", "node_modules");
  const targetNodeModules = join(buildRoot, "webui", "node_modules");
  await mkdir(targetNodeModules, { recursive: true });
  for (const entry of await readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name !== "@workbench-kit") {
      await symlink(join(sourceNodeModules, entry.name), join(targetNodeModules, entry.name));
      continue;
    }
    const targetScope = join(targetNodeModules, entry.name);
    await mkdir(targetScope, { recursive: true });
    for (const packageEntry of await readdir(join(sourceNodeModules, entry.name), { withFileTypes: true })) {
      const target = packageEntry.name === "vue"
        ? join(buildRoot, "vendor", "workbench-kit", "packages", "vue")
        : join(sourceNodeModules, entry.name, packageEntry.name);
      await symlink(target, join(targetScope, packageEntry.name));
    }
  }
}

async function createBuildRoot(releaseId: string, dirty: boolean): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (dirty) {
    const path = join(deployRoot, "build-snapshots", releaseId);
    await rm(path, { recursive: true, force: true });
    await copyTrackedWorkingTree(path);
    await linkBuildDependencies(path);
    return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
  }

  const path = join(projectRoot, ".worktrees", `.production-${releaseId}`);
  await mkdir(dirname(path), { recursive: true });
  run("git", ["worktree", "add", "--detach", path, "HEAD"], { stdio: "inherit" });
  try {
    run("git", ["submodule", "update", "--init", "--recursive"], { cwd: path, stdio: "inherit" });
    await linkBuildDependencies(path);
  } catch (error) {
    run("git", ["worktree", "remove", "--force", path], { allowFailure: true });
    throw error;
  }
  return {
    path,
    cleanup: async () => {
      run("git", ["worktree", "remove", "--force", path], { allowFailure: true });
    }
  };
}

async function prepareDependencySnapshot(sourceRoot: string): Promise<{ key: string; path: string }> {
  const lockHash = await sha256File(join(sourceRoot, "package-lock.json"));
  const modulesAbi = process.versions.modules ?? "unknown";
  const key = `${lockHash}-${platform()}-${arch()}-abi${modulesAbi}`;
  const finalPath = join(dependenciesRoot, key);
  if (await pathExists(join(finalPath, "node_modules"))) {
    return { key, path: finalPath };
  }

  await mkdir(dependenciesRoot, { recursive: true });
  const stagingPath = await mkdtemp(join(dependenciesRoot, `.staging-${key}-`));
  try {
    await cp(join(sourceRoot, "package.json"), join(stagingPath, "package.json"));
    await cp(join(sourceRoot, "package-lock.json"), join(stagingPath, "package-lock.json"));
    run("npm", ["ci", "--omit=dev", "--prefer-offline"], { cwd: stagingPath, stdio: "inherit" });
    run(process.execPath, [
      "-e",
      "const {createRequire}=require('node:module');const r=createRequire(process.cwd()+'/package.json');const Database=r('better-sqlite3');const db=new Database(':memory:');db.close();r('node-pty');r('sharp');"
    ], { cwd: stagingPath });
    try {
      await rename(stagingPath, finalPath);
    } catch (error) {
      if (!await pathExists(finalPath)) {
        throw error;
      }
    }
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
  return { key, path: finalPath };
}

async function publishWebAssets(sourceAssetsPath: string): Promise<string[]> {
  await mkdir(webAssetsRoot, { recursive: true });
  const files = await listFiles(sourceAssetsPath);
  for (const file of files) {
    const source = join(sourceAssetsPath, file);
    const destination = join(webAssetsRoot, file);
    await mkdir(dirname(destination), { recursive: true });
    if (await pathExists(destination)) {
      if (await sha256File(source) !== await sha256File(destination)) {
        throw new Error(`哈希资源发生同名内容冲突: ${file}`);
      }
      continue;
    }
    const temporary = `${destination}.next-${process.pid}`;
    await cp(source, temporary);
    await rename(temporary, destination);
  }
  return files;
}

async function writeChecksums(releasePath: string): Promise<void> {
  const lines: string[] = [];
  for (const root of ["dist", "webui/dist"]) {
    for (const file of await listFiles(join(releasePath, root))) {
      const relativePath = join(root, file);
      lines.push(`${await sha256File(join(releasePath, relativePath))}  ${relativePath}`);
    }
  }
  await writeFile(join(releasePath, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
}

async function validateBuiltWebui(webuiDist: string, assets: Set<string>): Promise<void> {
  const indexHtml = await readFile(join(webuiDist, "index.html"), "utf8");
  const references = Array.from(indexHtml.matchAll(/(?:src|href)="\/webui\/assets\/([^"]+)"/g), (match) => match[1]!);
  if (references.length === 0) {
    throw new Error("WebUI index.html 未引用入口资源");
  }
  for (const reference of references) {
    if (!assets.has(reference)) {
      throw new Error(`WebUI 入口引用缺失资源: ${reference}`);
    }
  }

  const serviceWorker = await readFile(join(webuiDist, "sw.js"), "utf8");
  const precachedAssets = Array.from(serviceWorker.matchAll(/"url":"assets\/([^"]+)"/g), (match) => match[1]!);
  for (const reference of precachedAssets) {
    if (!assets.has(reference)) {
      throw new Error(`Service Worker 引用缺失资源: ${reference}`);
    }
  }
}

async function createRelease(input: {
  releaseId: string;
  artifactsRoot: string;
  commit: string;
  dirty: boolean;
  sourceSnapshotSha256: string;
  dependencyKey: string;
  legacy?: boolean;
}): Promise<{ path: string; metadata: ReleaseMetadata }> {
  const finalPath = join(releasesRoot, input.releaseId);
  if (await pathExists(finalPath)) {
    throw new Error(`Release 已存在: ${input.releaseId}`);
  }
  await mkdir(releasesRoot, { recursive: true });
  const stagingPath = await mkdtemp(join(releasesRoot, `.staging-${input.releaseId}-`));
  try {
    await cp(join(input.artifactsRoot, "dist"), join(stagingPath, "dist"), { recursive: true });
    await cp(join(input.artifactsRoot, "webui", "dist"), join(stagingPath, "webui", "dist"), { recursive: true });
    await cp(join(input.artifactsRoot, "deploy", "run-release.mjs"), join(stagingPath, "run-release.mjs"));
    const webAssets = await publishWebAssets(join(stagingPath, "webui", "dist", "assets"));
    await validateBuiltWebui(join(stagingPath, "webui", "dist"), new Set(webAssets));
    await rm(join(stagingPath, "webui", "dist", "assets"), { recursive: true, force: true });
    await symlink(join("..", "..", "dependencies", input.dependencyKey, "node_modules"), join(stagingPath, "node_modules"));

    const metadata: ReleaseMetadata = {
      releaseId: input.releaseId,
      createdAt: new Date().toISOString(),
      sourceCommit: input.commit,
      dirty: input.dirty,
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      dependencyKey: input.dependencyKey,
      node: {
        version: process.version,
        modulesAbi: process.versions.modules ?? "unknown",
        platform: platform(),
        arch: arch()
      },
      webAssets,
      legacy: input.legacy ?? false
    };
    await writeFile(join(stagingPath, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeChecksums(stagingPath);
    await rename(stagingPath, finalPath);
    return { path: finalPath, metadata };
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

async function ensureLegacyRelease(dependencyKey: string, commit: string): Promise<string> {
  if (await pathExists(currentLink)) {
    return realpath(currentLink);
  }
  if (!existsSync(join(projectRoot, "dist", "index.mjs")) || !existsSync(join(projectRoot, "webui", "dist", "index.html"))) {
    throw new Error("首次迁移缺少当前 dist/webui/dist，无法创建旧运行快照");
  }
  const legacyId = `legacy-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}`;
  const legacy = await createRelease({
    releaseId: legacyId,
    artifactsRoot: projectRoot,
    commit,
    dirty: true,
    sourceSnapshotSha256: await hashLegacyArtifacts(projectRoot),
    dependencyKey,
    legacy: true
  });
  await replaceSymlink(currentLink, legacy.path);
  output(`已保存首次迁移前运行快照: ${legacyId}`);
  return legacy.path;
}

function renderManagedUnit(template: string): string {
  if (!template.startsWith(managedUnitMarker)) {
    throw new Error("systemd 模板缺少项目托管标记");
  }
  return template
    .replaceAll("@@PROJECT_ROOT@@", projectRoot)
    .replaceAll("@@NODE_PATH@@", process.execPath);
}

function systemctl(args: string[], allowFailure = false): CommandResult {
  return run("systemctl", ["--user", ...args], { allowFailure });
}

function unitName(instance: string): string {
  return `llm-bot@${instance}.service`;
}

function installedUnitPath(instance: string): string {
  return join(homedir(), ".config", "systemd", "user", unitName(instance));
}

function unitBackupPath(transactionPath: string, instance: string): string {
  return join(transactionPath, `unit-${instance}.before`);
}

function getEnableState(unit: string): string {
  return systemctl(["is-enabled", unit], true).stdout.trim() || "disabled";
}

function getMainPid(unit: string): number {
  const value = systemctl(["show", unit, "-p", "MainPID", "--value"], true).stdout.trim();
  return Number.parseInt(value, 10) || 0;
}

function isUnitActive(unit: string): boolean {
  return systemctl(["is-active", "--quiet", unit], true).status === 0;
}

async function captureUnitState(instance: ProductionInstance, unitFileExisted: boolean): Promise<TransactionUnitState> {
  const name = unitName(instance.name);
  const active = isUnitActive(name);
  let healthIdentity: Record<string, unknown> | null = null;
  if (active) {
    try {
      healthIdentity = await fetchHealth(instance.healthUrl);
    } catch {
      // Activation can still repair an unhealthy old service; rollback will
      // require the restored service to return at least a healthy response.
    }
  }
  return {
    name: instance.name,
    healthUrl: instance.healthUrl,
    unitName: name,
    unitFileExisted,
    active,
    enableState: getEnableState(name),
    mainPid: getMainPid(name),
    healthIdentity
  };
}

function restoreEnableState(unit: string, state: string): void {
  systemctl(["disable", unit]);
  if (state === "enabled-runtime") {
    systemctl(["enable", "--runtime", unit]);
  } else if (state === "enabled") {
    systemctl(["enable", unit]);
  } else if (state !== "disabled") {
    throw new Error(`${unit} 的 enable 状态不受支持: ${state}`);
  }

  const actual = getEnableState(unit);
  if (actual !== state) {
    throw new Error(`${unit} enable 状态恢复失败: 预期 ${state}，实际 ${actual}`);
  }
}

async function fetchHealth(healthUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(healthUrl, { cache: "no-store", signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json() as Record<string, unknown>;
}

async function waitForHealth(
  instance: ProductionInstance,
  releaseId: string,
  oldMainPid: number,
  timeoutMs: number
): Promise<void> {
  const unit = unitName(instance.name);
  const deadline = Date.now() + timeoutMs;
  let lastError = "尚未响应";
  while (Date.now() < deadline) {
    try {
      if (!isUnitActive(unit)) {
        throw new Error("systemd unit 未处于 active 状态");
      }
      const mainPid = getMainPid(unit);
      if (mainPid <= 0 || mainPid === oldMainPid) {
        throw new Error(`MainPID 尚未更新: ${mainPid}`);
      }
      const payload = await fetchHealth(instance.healthUrl);
      if (
        payload.ok === true
        && payload.instance === instance.name
        && payload.releaseId === releaseId
        && payload.pid === mainPid
      ) {
        return;
      }
      lastError = `身份或 PID 不匹配: systemd=${mainPid}, health=${JSON.stringify(payload)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`${instance.name} 健康检查超时: ${lastError}`);
}

function restoredHealthMatches(
  payload: Record<string, unknown>,
  unitState: TransactionUnitState,
  mainPid: number
): boolean {
  return payload.ok === true
    && (unitState.healthIdentity?.instance === undefined || payload.instance === unitState.healthIdentity.instance)
    && (unitState.healthIdentity?.releaseId === undefined || payload.releaseId === unitState.healthIdentity.releaseId)
    && (unitState.healthIdentity?.pid === undefined || payload.pid === mainPid);
}

async function waitForRestoredHealth(unitState: TransactionUnitState, timeoutMs: number): Promise<void> {
  if (!unitState.active) {
    if (isUnitActive(unitState.unitName)) {
      throw new Error(`${unitState.unitName} 应恢复为 inactive，但仍在运行`);
    }
    return;
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = "尚未响应";
  while (Date.now() < deadline) {
    try {
      const mainPid = getMainPid(unitState.unitName);
      if (!isUnitActive(unitState.unitName) || mainPid <= 0) {
        throw new Error("systemd unit 未恢复运行");
      }
      const payload = await fetchHealth(unitState.healthUrl);
      if (!restoredHealthMatches(payload, unitState, mainPid)) {
        throw new Error(`旧服务身份或 PID 不匹配: ${JSON.stringify(payload)}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
      if (isUnitActive(unitState.unitName) && getMainPid(unitState.unitName) === mainPid) {
        const confirmation = await fetchHealth(unitState.healthUrl);
        if (restoredHealthMatches(confirmation, unitState, mainPid)) {
          return;
        }
      }
      lastError = "恢复后的 systemd MainPID 未保持稳定";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`${unitState.name} 旧服务恢复检查超时: ${lastError}`);
}

async function verifyWebui(instance: ProductionInstance): Promise<void> {
  const origin = new URL(instance.healthUrl).origin;
  const root = await fetch(`${origin}/`, { redirect: "manual" });
  if (root.status !== 302 || root.headers.get("location") !== "/webui/") {
    throw new Error(`${instance.name} 根路径未正确跳转到 /webui/`);
  }
  const indexResponse = await fetch(`${origin}/webui/`, { cache: "no-store" });
  if (!indexResponse.ok || !indexResponse.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`${instance.name} WebUI 入口响应不正确`);
  }
  const indexHtml = await indexResponse.text();
  const scriptPath = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  if (!scriptPath) {
    throw new Error(`${instance.name} WebUI 入口未找到模块脚本`);
  }
  const scriptResponse = await fetch(new URL(scriptPath, origin), { cache: "no-store" });
  const scriptContentType = scriptResponse.headers.get("content-type") ?? "";
  if (!scriptResponse.ok || !/(?:application|text)\/javascript/.test(scriptContentType)) {
    throw new Error(`${instance.name} WebUI 脚本 MIME 错误: ${scriptResponse.status} ${scriptContentType}`);
  }
  const missingResponse = await fetch(`${origin}/webui/assets/__deployment_missing__.js`, { cache: "no-store" });
  if (missingResponse.status !== 404 || (missingResponse.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error(`${instance.name} 缺失脚本没有严格返回 404`);
  }
  const manifestResponse = await fetch(`${origin}/webui/manifest.webmanifest`, { cache: "no-store", redirect: "manual" });
  if (!manifestResponse.ok || manifestResponse.status >= 300) {
    throw new Error(`${instance.name} manifest 响应不正确`);
  }
}

async function restoreActivationTransaction(
  transactionPath: string,
  transaction: ActivationTransaction,
  healthTimeoutMs: number
): Promise<void> {
  await writeTransaction(transactionPath, { ...transaction, stage: "rolling_back" });
  await restoreSymlink(currentLink, transaction.oldCurrent);
  await restoreSymlink(previousLink, transaction.oldPrevious);
  for (const unit of transaction.units) {
    const targetPath = installedUnitPath(unit.name);
    if (unit.unitFileExisted) {
      await atomicWriteFile(targetPath, await readFile(unitBackupPath(transactionPath, unit.name), "utf8"));
    } else {
      await rm(targetPath, { force: true });
    }
  }
  systemctl(["daemon-reload"]);
  for (const unit of transaction.units) {
    systemctl(["stop", unit.unitName], true);
  }
  for (const unit of transaction.units) {
    restoreEnableState(unit.unitName, unit.enableState);
    if (unit.active) {
      systemctl(["start", unit.unitName]);
    }
  }
  for (const unit of transaction.units) {
    await waitForRestoredHealth(unit, healthTimeoutMs);
  }
  await writeTransaction(transactionPath, { releaseId: transaction.releaseId, stage: "rolled_back" });
}

async function cleanupStagingDirectories(): Promise<void> {
  for (const root of [releasesRoot, dependenciesRoot]) {
    if (!await pathExists(root)) {
      continue;
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(".staging-")) {
        await rm(join(root, entry.name), { recursive: true, force: true });
      }
    }
  }
}

async function cleanupInterruptedBuild(releaseId: string): Promise<void> {
  await rm(join(deployRoot, "build-snapshots", releaseId), { recursive: true, force: true });
  run("git", [
    "worktree",
    "remove",
    "--force",
    join(projectRoot, ".worktrees", `.production-${releaseId}`)
  ], { allowFailure: true });
  await cleanupStagingDirectories();
}

async function recoverInterruptedTransactions(healthTimeoutMs: number): Promise<void> {
  if (!await pathExists(transactionsRoot)) {
    return;
  }
  const entries = (await readdir(transactionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const transactionPath = join(transactionsRoot, entry.name);
    const statePath = join(transactionPath, "state.json");
    if (!await pathExists(statePath)) {
      continue;
    }
    const transaction = JSON.parse(await readFile(statePath, "utf8")) as DeploymentTransaction;
    if (transaction.stage === "building") {
      await writeTransaction(transactionPath, { releaseId: transaction.releaseId, stage: "abandoned" });
      await cleanupInterruptedBuild(transaction.releaseId);
      continue;
    }
    if (["activating", "rolling_back", "rollback_failed"].includes(transaction.stage)) {
      output(`发现未完成部署事务 ${transaction.releaseId}，先恢复部署前状态...`);
      try {
        await restoreActivationTransaction(transactionPath, transaction as ActivationTransaction, healthTimeoutMs);
        await cleanupInterruptedBuild(transaction.releaseId);
      } catch (error) {
        await writeTransaction(transactionPath, { ...(transaction as ActivationTransaction), stage: "rollback_failed" });
        throw new Error(`无法恢复中断事务 ${transaction.releaseId}: ${String(error)}`);
      }
    }
  }
  await cleanupStagingDirectories();
}

async function readReleaseMetadata(path: string): Promise<ReleaseMetadata> {
  return JSON.parse(await readFile(join(path, "release.json"), "utf8")) as ReleaseMetadata;
}

async function cleanupOldReleases(config: ProductionDeploymentConfig): Promise<void> {
  const current = await realpath(currentLink);
  const previous = await pathExists(previousLink) ? await realpath(previousLink) : null;
  const entries = await readdir(releasesRoot, { withFileTypes: true });
  const releases = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".staging-"))
    .map(async (entry) => {
      const path = join(releasesRoot, entry.name);
      return { path, metadata: await readReleaseMetadata(path), mtimeMs: (await stat(path)).mtimeMs };
    })))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const retained = new Set(releases.slice(0, config.retainReleases).map((item) => item.path));
  retained.add(current);
  if (previous) {
    retained.add(previous);
  }
  for (const release of releases) {
    if (!retained.has(release.path)) {
      await rm(release.path, { recursive: true, force: true });
    }
  }

  const retainedMetadata = await Promise.all(Array.from(retained).map(readReleaseMetadata));
  const referencedAssets = new Set(retainedMetadata.flatMap((metadata) => metadata.webAssets));
  for (const file of await listFiles(webAssetsRoot)) {
    if (!referencedAssets.has(file)) {
      await rm(join(webAssetsRoot, file), { force: true });
    }
  }
  const referencedDependencies = new Set(retainedMetadata.map((metadata) => metadata.dependencyKey));
  for (const entry of await readdir(dependenciesRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".staging-") && !referencedDependencies.has(entry.name)) {
      await rm(join(dependenciesRoot, entry.name), { recursive: true, force: true });
    }
  }
}

async function activateRelease(input: {
  releasePath: string;
  releaseId: string;
  renderedUnit: string;
  config: ProductionDeploymentConfig;
  transactionPath: string;
  oldCurrent: string;
  adoptUnit: boolean;
}): Promise<void> {
  const oldPrevious = await pathExists(previousLink) ? await realpath(previousLink) : null;
  const units: TransactionUnitState[] = [];
  for (const instance of input.config.instances) {
    const unitPath = installedUnitPath(instance.name);
    const unitFileExisted = await pathExists(unitPath);
    if (unitFileExisted) {
      const content = await readFile(unitPath, "utf8");
      if (!content.startsWith(managedUnitMarker) && !input.adoptUnit) {
        throw new Error(`现有 ${unitName(instance.name)} 专属 unit 不是部署脚本托管；如需接管请显式传入 --adopt-unit`);
      }
      await writeFile(unitBackupPath(input.transactionPath, instance.name), content, "utf8");
    }
    units.push(await captureUnitState(instance, unitFileExisted));
  }

  const transaction: ActivationTransaction = {
    releaseId: input.releaseId,
    stage: "activating",
    oldCurrent: input.oldCurrent,
    oldPrevious,
    units
  };
  await writeTransaction(input.transactionPath, transaction);
  try {
    await replaceSymlink(previousLink, input.oldCurrent);
    await replaceSymlink(currentLink, input.releasePath);
    for (const instance of input.config.instances) {
      await atomicWriteFile(installedUnitPath(instance.name), input.renderedUnit);
    }
    systemctl(["daemon-reload"]);
    systemctl(["restart", ...units.map((unit) => unit.unitName)]);
    for (const instance of input.config.instances) {
      const prior = units.find((unit) => unit.name === instance.name)!;
      await waitForHealth(instance, input.releaseId, prior.mainPid, input.config.healthTimeoutMs);
      await verifyWebui(instance);
    }
    for (const instance of input.config.instances) {
      const prior = units.find((unit) => unit.name === instance.name)!;
      if (instance.enableOnBoot === true) {
        restoreEnableState(unitName(instance.name), "enabled");
      } else if (instance.enableOnBoot === false) {
        restoreEnableState(unitName(instance.name), "disabled");
      } else {
        restoreEnableState(unitName(instance.name), prior.enableState);
      }
    }
  } catch (activationError) {
    output("新 Release 验证失败，正在恢复部署前状态...");
    try {
      await restoreActivationTransaction(input.transactionPath, transaction, input.config.healthTimeoutMs);
    } catch (rollbackError) {
      await writeTransaction(input.transactionPath, { ...transaction, stage: "rollback_failed" });
      throw new Error(
        `新 Release 激活失败，且旧服务恢复也失败。激活错误: ${String(activationError)}；恢复错误: ${String(rollbackError)}`
      );
    }
    throw activationError;
  }
}

async function main(): Promise<void> {
  await ensureKernelLock();
  const args = parseArgs();
  const config = await loadProductionDeploymentConfig(productionConfigPath);
  await recoverInterruptedTransactions(config.healthTimeoutMs);

  const gitStatus = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  const dirty = gitStatus.trim().length > 0;
  if (dirty && !args.allowDirty) {
    throw new Error("正式部署默认要求干净工作区；如需部署当前快照，请显式传入 --allow-dirty");
  }
  const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const releaseId = createReleaseId(commit, dirty);
  await mkdir(transactionsRoot, { recursive: true });
  const transactionPath = join(transactionsRoot, releaseId);
  await mkdir(transactionPath, { recursive: true });
  await writeTransaction(transactionPath, { releaseId, stage: "building" });
  const build = await createBuildRoot(releaseId, dirty);
  try {
    const sourceSnapshotSha256 = await hashSourceSnapshot(build.path);
    const buildEnv = { ...process.env, LLM_BOT_RELEASE_ID: releaseId };
    if (!args.skipChecks) {
      output("运行类型检查...");
      run("npm", ["run", "typecheck:all"], { cwd: build.path, env: buildEnv, stdio: "inherit" });
      output("运行完整测试...");
      run("npm", ["run", "test"], { cwd: build.path, env: buildEnv, stdio: "inherit" });
      output("构建后端产物...");
      run("npm", ["run", "build:bot"], { cwd: build.path, env: buildEnv, stdio: "inherit" });
    } else {
      output("跳过检查，仅构建正式产物...");
      run("npm", ["run", "build"], { cwd: build.path, env: buildEnv, stdio: "inherit" });
    }

    const dependency = await prepareDependencySnapshot(build.path);
    const oldCurrent = await ensureLegacyRelease(dependency.key, commit);
    const release = await createRelease({
      releaseId,
      artifactsRoot: build.path,
      commit,
      dirty,
      sourceSnapshotSha256,
      dependencyKey: dependency.key
    });
    output(`Release 已准备: ${release.metadata.releaseId}`);

    const unitTemplate = await readFile(join(build.path, productionUnitTemplateRelativePath), "utf8");
    await activateRelease({
      releasePath: release.path,
      releaseId,
      renderedUnit: renderManagedUnit(unitTemplate),
      config,
      transactionPath,
      oldCurrent,
      adoptUnit: args.adoptUnit
    });
    await writeTransaction(transactionPath, { releaseId, stage: "activated" });
    await cleanupOldReleases(config);
    await writeTransaction(transactionPath, { releaseId, stage: "complete" });
    output(`正式部署完成: ${releaseId}`);
  } finally {
    await build.cleanup();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

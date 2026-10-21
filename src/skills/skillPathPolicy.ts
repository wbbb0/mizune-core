import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
/** 解析尚未创建的路径时，先解析最近现存祖先，覆盖符号链接别名。 */
function canonicalPath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor)
      break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...suffix);
}
function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return remainder === "" || (!remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && remainder !== ".." && !isAbsolute(remainder));
}
export function isSkillLibraryPath(dataDir: string, path: string, protectsAncestors = false): boolean {
  const root = canonicalPath(resolve(dataDir, "skills"));
  const target = canonicalPath(path);
  if (contains(root, target) || (protectsAncestors && contains(target, root))) {
    return true;
  }
  return false;
}
export function assertOutsideSkillLibrary(dataDir: string, path: string, protectsAncestors = false): void {
  if (isSkillLibraryPath(dataDir, path, protectsAncestors))
    throw new Error("技能库必须通过专用技能接口访问，不能通过通用文件工具修改或移除。");
}

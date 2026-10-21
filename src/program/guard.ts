import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { ProgramError } from "./errors.js";

export type DangerKind =
  | "recursive_delete"
  | "git_destructive"
  | "disk_format"
  | "dd_device"
  | "fork_bomb"
  | "sudo"
  | "root_destroy"
  | "localspace_state";

export interface DangerHit {
  kind: DangerKind;
  message: string;
  target?: string;
}

const RECURSIVE_RM =
  /(^|[;&|\n])\s*(rm\s+(-[^\n;|&]*[rf][^\n;|&]*|-[^\n;|&]*[fr][^\n;|&]*)|rimraf\b|rd\s+\/s|rmdir\s+\/s|del\s+\/s)/i;
const GIT_DESTRUCTIVE =
  /\bgit\s+(reset\s+--hard|push\b[^\n;|&]*(--force|-f)\b|branch\s+-D\b)/i;
const GIT_CLEAN = /\bgit\s+clean\b/i;
const DISK_FORMAT = /(^|[;&|\n])\s*(mkfs\b|diskpart\b|format(?:\.com)?(?=\s|$))/i;
const DD_DEVICE = /\bdd\b[^\n;|&]*\bof=\s*(\/dev\/[^\s;|&]+)/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\s*\}\s*;/;
const SUDO = /(^|[;&|\n])\s*(sudo\b|su\s)/i;

export function analyzeCommandDanger(command: string): DangerHit | undefined {
  const c = command.trim();
  if (!c) return undefined;
  if (FORK_BOMB.test(c)) return { kind: "fork_bomb", message: "疑似 fork 炸弹。", target: c.slice(0, 80) };
  if (DISK_FORMAT.test(c)) return { kind: "disk_format", message: "可能格式化磁盘或分区。", target: c.slice(0, 80) };
  const dd = DD_DEVICE.exec(c);
  if (dd) return { kind: "dd_device", message: "dd 写入块设备。", target: dd[1] };
  if (RECURSIVE_RM.test(c)) return { kind: "recursive_delete", message: "递归/强制删除。", target: c.slice(0, 80) };
  if (GIT_DESTRUCTIVE.test(c)) return { kind: "git_destructive", message: "破坏性 git 操作。", target: c.slice(0, 80) };
  if (GIT_CLEAN.test(c) && !/--dry-run|\s-n\b/.test(c) && /(--force|\s-f\b)/.test(c)) {
    return { kind: "git_destructive", message: "git clean 强制清理。", target: c.slice(0, 80) };
  }
  if (SUDO.test(c)) return { kind: "sudo", message: "提权执行（sudo/su）。", target: c.slice(0, 80) };
  return undefined;
}

export function assertInsideRoots(absolutePath: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(absolutePath);
  for (const root of allowedRoots) {
    const r = resolve(root);
    if (resolvedPath === r || resolvedPath.startsWith(r.endsWith("/") ? r : r + "/")) return resolvedPath;
  }
  throw new ProgramError("PATH_DENIED", "路径越出允许根：" + resolvedPath);
}

export function assertNotAuthFile(absolutePath: string, configDir: string): void {
  if (resolve(absolutePath) === resolve(configDir, "auth.json")) {
    throw new ProgramError("AUTH_PROTECTED", "禁止通过工具改写 LocalSpace 的 auth.json。");
  }
}

export function analyzePathDanger(absolutePath: string, allowedRoots: string[]): DangerHit | undefined {
  const resolvedPath = resolve(absolutePath);
  const home = resolve(homedir());
  if (resolvedPath === "/" || resolvedPath === home) {
    return { kind: "root_destroy", message: "针对系统根或家目录根的危险操作。", target: resolvedPath };
  }
  for (const root of allowedRoots) {
    if (resolvedPath === resolve(root)) {
      return { kind: "root_destroy", message: "针对允许根本根的危险操作。", target: resolvedPath };
    }
  }
  return undefined;
}

export function isLocalspaceStatePath(absolutePath: string, configDir: string, stateDir: string): boolean {
  const resolvedPath = resolve(absolutePath);
  if (resolvedPath === resolve(configDir, "config.json")) return true;
  if (resolvedPath === resolve(configDir, "auth.json")) return true;
  const state = resolve(stateDir);
  return resolvedPath === state || resolvedPath.startsWith(state.endsWith("/") ? state : state + "/");
}

export function confirmPayload(hit: DangerHit): Record<string, unknown> {
  return {
    kind: "confirm",
    danger: hit.kind,
    message: hit.message,
    target: hit.target,
    accept: { dangerous: true },
    hint: "在新 program 中调用 unpark(handle, { dangerous: true }) 以强制继续。",
  };
}
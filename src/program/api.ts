import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir, stat as fsStat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { ProgramError } from "./errors.js";
import {
  analyzeCommandDanger,
  analyzePathDanger,
  assertInsideRoots,
  assertNotAuthFile,
  confirmPayload,
  isLocalspaceStatePath,
  type DangerHit,
} from "./guard.js";
import { nearestLine, whereAll, whereCandidates } from "./where.js";
import type { CallOpts, CallResult } from "./call.js";

export interface ApiContext {
  workspaceId: string;
  root: string;
  allowedRoots: string[];
  configDir: string;
  stateDir: string;
  written: string[];
  /** Pause the program until a later this.unpark(handle, value) (worker-side park). */
  requestPark: (kind: "where" | "park" | "confirm", payload: unknown) => Promise<unknown>;
  runCall: (command: string, planB: string, opts: CallOpts) => Promise<CallResult>;
  signalParked: (signal?: string) => Promise<void>;
  sendParked: (input: string) => Promise<void>;
}

/** cat refuses files above this size; read slices with this.call("head -c …") or this.rg instead. */
export const CAT_MAX_BYTES = 8 * 1024 * 1024;
/** rg output above this size is refused rather than silently cut mid-record. */
export const RG_MAX_BYTES = 8 * 1024 * 1024;

export function createProgramApi(ctx: ApiContext) {
  const resolvePath = (input: string): string =>
    assertInsideRoots(resolve(ctx.root, input), ctx.allowedRoots);

  const rel = (absolute: string): string => relative(ctx.root, absolute) || ".";

  const noteWrite = (absolute: string) => {
    const r = rel(absolute);
    if (!ctx.written.includes(r)) ctx.written.push(r);
  };

  const requireDanger = async (hit: DangerHit, already: boolean) => {
    if (already) return;
    const value = await ctx.requestPark("confirm", confirmPayload(hit));
    const accepted =
      !!value && typeof value === "object" && (value as { dangerous?: unknown }).dangerous === true;
    if (!accepted) {
      throw new ProgramError(
        "DANGEROUS_REQUIRES_FLAG",
        `${hit.message} 请 this.unpark(handle, { dangerous: true }) 后继续。`,
      );
    }
  };

  const guardWritePath = async (absolute: string, forceDangerous: boolean) => {
    assertNotAuthFile(absolute, ctx.configDir);
    assertInsideRoots(absolute, ctx.allowedRoots);
    if (isLocalspaceStatePath(absolute, ctx.configDir, ctx.stateDir)) {
      await requireDanger(
        { kind: "localspace_state", message: "写入 LocalSpace 自身状态。", target: absolute },
        forceDangerous,
      );
    }
    const rootHit = analyzePathDanger(absolute, ctx.allowedRoots);
    if (rootHit) await requireDanger(rootHit, forceDangerous);
  };

  const runCall = async (command: string, planB: string, opts: CallOpts = {}): Promise<CallResult> => {
    if (typeof command !== "string" || !command) {
      throw new ProgramError("CALL_COMMAND_UNSUPPORTED", "this.call 需要一条命令字符串。");
    }
    if (typeof planB !== "string" || !planB) {
      throw new ProgramError("CALL_COMMAND_UNSUPPORTED", "this.call 必填 planB（不跑该命令时的替代方案）。");
    }
    const hit = analyzeCommandDanger(command);
    if (hit) await requireDanger(hit, false);
    return ctx.runCall(command, planB, opts);
  };

  async function cat(path: string): Promise<string> {
    const absolute = resolvePath(path);
    try {
      const size = (await fsStat(absolute)).size;
      if (size > CAT_MAX_BYTES) {
        throw new ProgramError(
          "FILE_TOO_LARGE",
          `文件过大（${size} 字节 > ${CAT_MAX_BYTES}）：${path}。请用 this.rg 搜索，或 this.call("head -c N 文件") / sed -n 切片读取。`,
        );
      }
      const buf = await readFile(absolute);
      if (buf.includes(0)) throw new ProgramError("INVALID_UTF8", `文件含 NUL：${path}`);
      return buf.toString("utf8");
    } catch (error) {
      if (error instanceof ProgramError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProgramError("FILE_NOT_FOUND", `文件不存在：${path}`);
      }
      throw new ProgramError("READ_FAILED", `读取失败：${path}: ${(error as Error).message}`);
    }
  }

  async function stat(path: string) {
    const absolute = resolve(ctx.root, path);
    try {
      assertInsideRoots(absolute, ctx.allowedRoots);
      const info = await fsStat(absolute);
      return { exists: true, size: info.size, mtime: info.mtime.toISOString(), isDir: info.isDirectory() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, size: 0, mtime: null, isDir: false };
      }
      if (error instanceof ProgramError) throw error;
      throw new ProgramError("STAT_FAILED", `stat 失败：${path}: ${(error as Error).message}`);
    }
  }

  async function ls(path: string): Promise<string[]> {
    const absolute = resolvePath(path);
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  }

  async function rg(argv: string[]) {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
      throw new ProgramError("RG_FAILED", "rg(argv) 需要字符串数组。");
    }
    for (const arg of argv) {
      if (arg.startsWith("-")) continue;
      if (arg.includes("..") || arg.startsWith("/")) {
        assertInsideRoots(resolve(ctx.root, arg), [ctx.root]);
      }
    }
    const summary = argv.some((a) =>
      ["--files", "--files-with-matches", "-l", "--count"].includes(a),
    );
    const args = summary ? [...argv] : ["--json", ...argv];
    const cmd = ["rg", ...args].map(shellQuote).join(" ");
    const result = await runCall(cmd, "rg", { maxOutputBytes: RG_MAX_BYTES });
    if (result.truncated) {
      throw new ProgramError(
        "RG_OUTPUT_TOO_LARGE",
        `rg 输出超过 ${RG_MAX_BYTES} 字节（共 ${result.bytes.stdout}）。请收窄路径/模式，或加 --max-count / -l。`,
      );
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ProgramError("RG_FAILED", result.stderr || `rg 退出码 ${result.exitCode}`);
    }
    if (summary) {
      return {
        exitCode: result.exitCode,
        paths: result.stdout.split("\n").map((l: string) => l.trim()).filter(Boolean),
      };
    }
    const messages = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: "raw", text: line };
        }
      });
    return { exitCode: result.exitCode, messages };
  }

  async function where(content: string, needle: string, from = 0): Promise<[number, number]> {
    if (typeof content !== "string" || typeof needle !== "string") {
      throw new ProgramError("INVALID_ARGUMENT", "where(content, needle) 需要字符串。");
    }
    const spans = whereAll(content, needle, from);
    if (spans.length === 1) return spans[0]!;
    const payload = {
      needle,
      candidates: whereCandidates(content, spans),
      nearest: spans.length === 0 ? nearestLine(content, needle) : null,
    };
    const injected = await ctx.requestPark("where", payload);
    if (
      Array.isArray(injected) &&
      injected.length === 2 &&
      typeof injected[0] === "number" &&
      typeof injected[1] === "number"
    ) {
      return injected as [number, number];
    }
    throw new ProgramError("WHERE_RESUME_INVALID", "unpark 应注入 [begin, end]。");
  }

  async function write(path: string, content: string, opts?: { dangerous?: boolean }) {
    if (typeof content !== "string") {
      throw new ProgramError("INVALID_ARGUMENT", "write 的 content 必须是字符串。");
    }
    const absolute = resolvePath(path);
    await guardWritePath(absolute, opts?.dangerous === true);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
    noteWrite(absolute);
  }

  async function mkdir(path: string) {
    const absolute = resolvePath(path);
    await guardWritePath(absolute, false);
    try {
      mkdirSync(absolute, { recursive: false });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new ProgramError("DIRECTORY_EXISTS", `目录已存在：${path}`);
      if (code === "ENOENT") throw new ProgramError("PARENT_DIRECTORY_MISSING", `父目录不存在：${path}`);
      throw error;
    }
    noteWrite(absolute);
  }

  async function mv(from: string, to: string, opts?: { dangerous?: boolean }) {
    const src = resolvePath(from);
    const dst = resolvePath(to);
    await guardWritePath(src, opts?.dangerous === true);
    await guardWritePath(dst, opts?.dangerous === true);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    noteWrite(src);
    noteWrite(dst);
  }

  async function rmPath(path: string, opts?: { dangerous?: boolean; recursive?: boolean }) {
    const absolute = resolvePath(path);
    await guardWritePath(absolute, opts?.dangerous === true);
    if (opts?.recursive) {
      await requireDanger(
        { kind: "recursive_delete", message: "递归删除。", target: absolute },
        opts.dangerous === true,
      );
    }
    try {
      rmSync(absolute, { recursive: !!opts?.recursive, force: false });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY") {
        throw new ProgramError(
          "DIRECTORY_NOT_EMPTY",
          `目录非空：${path}。递归删除请 this.rm(path, { recursive: true })。`,
        );
      }
      if (code === "ENOENT") throw new ProgramError("FILE_NOT_FOUND", `不存在：${path}`);
      throw error;
    }
    noteWrite(absolute);
  }

  async function call(command: string, planB: string): Promise<CallResult> {
    return runCall(command, planB, {});
  }

  async function signal(signalName?: string): Promise<void> {
    return ctx.signalParked(signalName);
  }

  async function send(input: string): Promise<void> {
    return ctx.sendParked(input);
  }

  async function park(payload: unknown): Promise<unknown> {
    return ctx.requestPark("park", payload ?? null);
  }

  return {
    cat,
    stat,
    ls,
    rg,
    where,
    whereAll,
    write,
    mkdir,
    mv,
    rm: rmPath,
    call,
    signal,
    send,
    park,
  };
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\''`)}'`;
}

export type { CallResult } from "./call.js";

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
import { whereAll, whereCandidates } from "./where.js";
import type { CallOpts, CallResult } from "./call.js";
import type { SembleContent, SembleTool } from "./semble.js";

export interface ApiContext {
  workspaceId: string;
  root: string;
  allowedRoots: string[];
  configDir: string;
  stateDir: string;
  written: string[];
  /** Pause the program until a later this.unpark(handle, value) (worker-side park). */
  requestPark: (kind: "where" | "park" | "confirm", payload: unknown) => Promise<unknown>;
  runCall: (command: string, opts: CallOpts) => Promise<CallResult>;
  signalParked: (signal?: string) => Promise<void>;
  sendParked: (input: string) => Promise<void>;
  /** Built-in Semble search; `repo` is always bound to this workspace root by the main thread. */
  runSemble: (tool: SembleTool, args: Record<string, unknown>) => Promise<unknown>;
}

export interface SembleOptions {
  /** Results to return (1-50). */
  topK?: number;
  /** Lines of source per result; null = the whole chunk, 0 = location only. */
  maxSnippetLines?: number | null;
  content?: SembleContent;
}

/** cat refuses files above this size; use this.search / this.call("head -c …") instead. */
export const CAT_MAX_BYTES = 8 * 1024 * 1024;

const SEMBLE_CONTENT: readonly SembleContent[] = ["code", "docs", "config", "all"];

function sembleArgs(opts?: SembleOptions): Record<string, unknown> {
  if (opts === undefined) return {};
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    throw new ProgramError("INVALID_ARGUMENT", "搜索选项必须是对象，如 { topK: 5 }。");
  }
  const args: Record<string, unknown> = {};
  if (opts.topK !== undefined) {
    if (!Number.isInteger(opts.topK) || opts.topK < 1 || opts.topK > 50) {
      throw new ProgramError("INVALID_ARGUMENT", "topK 必须是 1-50 的整数。");
    }
    args.top_k = opts.topK;
  }
  if (opts.maxSnippetLines !== undefined) {
    if (opts.maxSnippetLines !== null && (!Number.isInteger(opts.maxSnippetLines) || opts.maxSnippetLines < 0)) {
      throw new ProgramError("INVALID_ARGUMENT", "maxSnippetLines 必须是 >=0 的整数或 null（整块）。");
    }
    args.max_snippet_lines = opts.maxSnippetLines;
  }
  if (opts.content !== undefined) {
    if (!SEMBLE_CONTENT.includes(opts.content)) {
      throw new ProgramError("INVALID_ARGUMENT", `content 只能是 ${SEMBLE_CONTENT.join("/")}。`);
    }
    args.content = opts.content;
  }
  return args;
}

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

  const runCall = async (command: string, opts: CallOpts = {}): Promise<CallResult> => {
    if (typeof command !== "string" || !command) {
      throw new ProgramError("CALL_COMMAND_UNSUPPORTED", "this.call 需要一条命令字符串。");
    }
    const hit = analyzeCommandDanger(command);
    if (hit) await requireDanger(hit, false);
    return ctx.runCall(command, opts);
  };

  async function cat(path: string): Promise<string> {
    const absolute = resolvePath(path);
    try {
      const size = (await fsStat(absolute)).size;
      if (size > CAT_MAX_BYTES) {
        throw new ProgramError(
          "FILE_TOO_LARGE",
          `文件过大（${size} 字节 > ${CAT_MAX_BYTES}）：${path}。请用 this.search 定位，或 this.call("head -c N 文件") / sed -n 切片读取。`,
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

  async function search(query: string, opts?: SembleOptions) {
    if (typeof query !== "string" || !query.trim()) {
      throw new ProgramError("INVALID_ARGUMENT", "this.search(query) 需要非空的自然语言或代码查询。");
    }
    return ctx.runSemble("search", { query, ...sembleArgs(opts) });
  }

  async function findRelated(path: string, line: number, opts?: SembleOptions) {
    if (typeof path !== "string" || !path.trim()) {
      throw new ProgramError("INVALID_ARGUMENT", "this.findRelated(path, line) 需要文件路径。");
    }
    if (!Number.isInteger(line) || line < 1) {
      throw new ProgramError("INVALID_ARGUMENT", "this.findRelated 的 line 必须是 1 起的整数。");
    }
    const absolute = resolvePath(path);
    return ctx.runSemble("find_related", { file_path: rel(absolute), line, ...sembleArgs(opts) });
  }

  async function where(content: string, needle: string): Promise<[number, number]> {
    if (typeof content !== "string" || typeof needle !== "string") {
      throw new ProgramError("INVALID_ARGUMENT", "where(content, needle) 需要字符串。");
    }
    const spans = whereAll(content, needle);
    if (spans.length === 1) return spans[0]!;
    const payload = {
      needle,
      candidates: whereCandidates(content, spans),
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

  async function call(command: string): Promise<CallResult> {
    if (arguments.length !== 1)
      throw new ProgramError("INVALID_ARGUMENT", "call(command) 只接受一个参数；等待预算来自 js 工具顶层 planB。");
    return runCall(command, {});
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
    search,
    findRelated,
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

export type { CallResult } from "./call.js";

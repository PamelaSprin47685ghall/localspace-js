import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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

const STREAM_CAP = 128 * 1024;

export interface ApiContext {
  workspaceId: string;
  root: string;
  allowedRoots: string[];
  configDir: string;
  stateDir: string;
  written: string[];
  requestPark: (kind: "where" | "park" | "confirm" | "yield", payload: unknown) => Promise<unknown>;
  deadlineMs: number;
  checkYield: () => Promise<void>;
}

export interface CallResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  bytes: { stdout: number; stderr: number };
  durationMs: number;
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
        `${hit.message} 请 unpark(handle, { dangerous: true }) 后继续。`,
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

  async function cat(path: string): Promise<string> {
    await ctx.checkYield();
    const absolute = resolvePath(path);
    try {
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
    await ctx.checkYield();
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
    await ctx.checkYield();
    const absolute = resolvePath(path);
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  }

  async function rg(argv: string[]) {
    await ctx.checkYield();
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
    const result = await runProcess("rg", args, ctx.root, ctx.deadlineMs);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ProgramError("RG_FAILED", result.stderr || `rg 退出码 ${result.exitCode}`);
    }
    if (summary) {
      return {
        exitCode: result.exitCode,
        paths: result.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
      };
    }
    const messages = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: "raw", text: line };
        }
      });
    return { exitCode: result.exitCode, messages };
  }

  async function where(content: string, needle: string, from = 0): Promise<[number, number]> {
    await ctx.checkYield();
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
    await ctx.checkYield();
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
    await ctx.checkYield();
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
    await ctx.checkYield();
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
    await ctx.checkYield();
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
          `目录非空：${path}。递归删除请 rm(path, { recursive: true })。`,
        );
      }
      if (code === "ENOENT") throw new ProgramError("FILE_NOT_FOUND", `不存在：${path}`);
      throw error;
    }
    noteWrite(absolute);
  }

  async function call(
    commandOrSpec: string | Record<string, unknown>,
    opts: { cwd?: string; env?: Record<string, string>; dangerous?: boolean; timeoutMs?: number } = {},
  ): Promise<CallResult> {
    await ctx.checkYield();
    if (typeof commandOrSpec !== "string") {
      throw new ProgramError(
        "CALL_UNSUPPORTED",
        "当前版本 call 仅支持字符串命令。请用 call(\"...\")。",
      );
    }
    const hit = analyzeCommandDanger(commandOrSpec);
    if (hit) await requireDanger(hit, opts.dangerous === true);
    const cwd = resolvePath(opts.cwd ?? ".");
    const remaining = Math.max(1, ctx.deadlineMs - Date.now());
    const timeoutMs = Math.min(opts.timeoutMs ?? remaining, remaining);
    const result = await runShell(commandOrSpec, cwd, timeoutMs, opts.env);
    if (Date.now() >= ctx.deadlineMs) {
      await ctx.requestPark("yield", {
        message: "已达自动挂起时限。",
        phase: "call",
        command: commandOrSpec,
        exitCode: result.exitCode,
        stdoutTail: result.stdout.slice(-2000),
        stderrTail: result.stderr.slice(-2000),
      });
    }
    return result;
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
    park,
  };
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<CallResult> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new HeadTail(STREAM_CAP);
    const stderr = new HeadTail(STREAM_CAP);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProgramError("CALL_FAILED", error.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        ...(signal ? { signal } : {}),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
        bytes: { stdout: stdout.total, stderr: stderr.total },
        durationMs: Date.now() - started,
      } as CallResult);
    });
  });
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  deadlineMs: number,
): Promise<CallResult> {
  const timeoutMs = Math.max(1, deadlineMs - Date.now());
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = new HeadTail(STREAM_CAP);
    const stderr = new HeadTail(STREAM_CAP);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProgramError("RG_FAILED", error.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        ...(signal ? { signal } : {}),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
        bytes: { stdout: stdout.total, stderr: stderr.total },
        durationMs: Date.now() - started,
      } as CallResult);
    });
  });
}

class HeadTail {
  private head: Buffer[] = [];
  private tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  total = 0;
  truncated = false;
  constructor(private readonly cap: number) {}
  push(chunk: Buffer) {
    this.total += chunk.length;
    if (this.headBytes < this.cap) {
      const take = Math.min(chunk.length, this.cap - this.headBytes);
      this.head.push(chunk.subarray(0, take));
      this.headBytes += take;
      if (take < chunk.length) {
        this.truncated = true;
        this.pushTail(chunk.subarray(take));
      }
      return;
    }
    this.truncated = true;
    this.pushTail(chunk);
  }
  private pushTail(chunk: Buffer) {
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.cap && this.tail.length > 1) {
      const dropped = this.tail.shift()!;
      this.tailBytes -= dropped.length;
    }
    if (this.tailBytes > this.cap && this.tail.length === 1) {
      const only = this.tail[0]!;
      this.tail[0] = only.subarray(only.length - this.cap);
      this.tailBytes = this.cap;
    }
  }
  toString() {
    const head = Buffer.concat(this.head).toString("utf8");
    if (!this.truncated) return head;
    return `${head}\n/* …截断… */\n${Buffer.concat(this.tail).toString("utf8")}`;
  }
}

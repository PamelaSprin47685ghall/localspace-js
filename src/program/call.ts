import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { ProgramError } from "./errors.js";

/** Per-stream capture cap: keep the last N bytes, count what was dropped. */
export const STREAM_CAP = 128 * 1024;
const KILL_GRACE_MS = 2000;
const DRAIN_GRACE_MS = 200;

export interface CallResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  /** true when any stream dropped bytes (only the tail is kept). */
  truncated: boolean;
  bytes: { stdout: number; stderr: number };
  truncatedBytes: { stdout: number; stderr: number };
  durationMs: number;
  name?: string;
  pid?: number;
}

/**
 * Runs on the main thread: the process that spawns a child must also reap it, and a terminated
 * worker cannot. Danger checks and cwd confinement are done by the caller (the program API).
 */
export interface CallContext {
  /** Default cwd (the workspace root). */
  root: string;
}

export type CallOpts = {
  cwd?: string;
  env?: Record<string, string>;
  dangerous?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
};
type SpawnSpec = { spawn: string; name: string; cwd?: string; env?: Record<string, string>; dangerous?: boolean };
type SendSpec = { send: { name: string; input: string } };
type SignalSpec = { signal: NodeJS.Signals | string; name: string };
type WaitForSpec = { waitFor: { port: number; timeoutMs?: number; host?: string } };
type ReadSpec = { read: { name: string; waitMs?: number } };
type JoinSpec = { join: { name: string; timeoutMs?: number } };
export type CallSpec = string | SpawnSpec | SendSpec | SignalSpec | WaitForSpec | ReadSpec | JoinSpec;

/** One shell process in its own process group, with capped capture. */
class Proc {
  readonly stdout: TailBuffer;
  readonly stderr: TailBuffer;
  readonly startedAt = Date.now();
  exitCode: number | null = null;
  signal?: string;
  exited = false;
  readonly exitPromise: Promise<void>;
  private readonly closed: Promise<void>;

  constructor(
    readonly child: ChildProcess,
    readonly name: string | undefined,
    cap: number,
  ) {
    this.stdout = new TailBuffer(cap);
    this.stderr = new TailBuffer(cap);
    child.stdout?.on("data", (c: Buffer) => this.stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => this.stderr.push(c));
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, sig) => {
        this.exited = true;
        this.exitCode = code;
        this.signal = sig ?? undefined;
        resolve();
      });
      child.once("error", (error) => {
        this.exited = true;
        this.exitCode = null;
        this.stderr.push(Buffer.from(`\n[spawn error] ${error.message}\n`));
        resolve();
      });
    });
    this.closed = new Promise((resolve) => child.once("close", () => resolve()));
  }

  get pgid(): number | undefined {
    return this.child.pid;
  }

  /** Wait for the shell to exit, then briefly for pipes to drain (a leftover grandchild may hold them). */
  async settle(): Promise<void> {
    await this.exitPromise;
    await Promise.race([this.closed, sleep(DRAIN_GRACE_MS)]);
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  result(): CallResult {
    return {
      exitCode: this.exitCode,
      ...(this.signal ? { signal: this.signal } : {}),
      stdout: this.stdout.toString(),
      stderr: this.stderr.toString(),
      truncated: this.stdout.dropped > 0 || this.stderr.dropped > 0,
      bytes: { stdout: this.stdout.total, stderr: this.stderr.total },
      truncatedBytes: { stdout: this.stdout.dropped, stderr: this.stderr.dropped },
      durationMs: Date.now() - this.startedAt,
      ...(this.name ? { name: this.name } : {}),
      ...(this.pgid ? { pid: this.pgid } : {}),
    };
  }
}

export class CallHub {
  private readonly named = new Map<string, Proc>();
  private readonly groups = new Set<number>();

  constructor(private readonly ctx: CallContext) {}

  async call(spec: CallSpec, opts: CallOpts = {}): Promise<CallResult> {
    if (typeof spec === "string") return this.foreground(spec, opts);
    if ("spawn" in spec) return this.spawnNamed(spec);
    if ("send" in spec) return this.send(spec);
    if ("signal" in spec) return this.signal(spec);
    if ("waitFor" in spec) return this.waitFor(spec);
    if ("read" in spec) return this.read(spec);
    if ("join" in spec) return this.join(spec);
    throw new ProgramError("CALL_UNSUPPORTED", "无法识别的 call 参数。");
  }

  /** Kill every process group this hub started (SIGTERM, then SIGKILL). */
  dispose(): void {
    for (const pgid of this.groups) killGroup(pgid);
    this.groups.clear();
    this.named.clear();
  }

  private start(command: string, o: { cwd?: string; env?: Record<string, string>; stdin: boolean; name?: string; cap?: number }): Proc {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: o.cwd ?? this.ctx.root,
      env: { ...process.env, ...(o.env ?? {}) },
      stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true, // own process group: pgid === pid
    });
    const proc = new Proc(child, o.name, o.cap ?? STREAM_CAP);
    if (child.pid) this.groups.add(child.pid);
    return proc;
  }

  private async foreground(command: string, opts: CallOpts): Promise<CallResult> {
    const proc = this.start(command, { ...opts, stdin: false, cap: opts.maxOutputBytes });
    let timer: NodeJS.Timeout | undefined;
    const timedOut =
      opts.timeoutMs != null
        ? new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), opts.timeoutMs)))
        : new Promise<never>(() => {});
    const outcome = await Promise.race([proc.settle().then(() => "done" as const), timedOut]);
    if (timer) clearTimeout(timer);
    // 防呆: a foreground call owns its whole process group. Leftovers die with it;
    // use { spawn } for anything that must keep running.
    this.reap(proc);
    if (outcome === "timeout") {
      await proc.settle();
      throw new ProgramError("CALL_TIMEOUT", `命令超时（${opts.timeoutMs}ms），已终止其进程组：${command.slice(0, 120)}`);
    }
    return proc.result();
  }

  private async spawnNamed(spec: SpawnSpec): Promise<CallResult> {
    const name = spec.name?.trim();
    if (!name) throw new ProgramError("CALL_CHILD_UNKNOWN", "spawn 需要 name。");
    const existing = this.named.get(name);
    if (existing && !existing.exited) throw new ProgramError("CALL_CHILD_EXISTS", `后台进程已存在：${name}`);
    const proc = this.start(spec.spawn, { ...spec, stdin: true, name });
    this.named.set(name, proc);
    return proc.result();
  }

  private async send(spec: SendSpec): Promise<CallResult> {
    const proc = this.requireNamed(spec.send.name);
    if (proc.exited) throw new ProgramError("CALL_CHILD_EXITED", `进程已退出：${proc.name}`);
    let input = spec.send.input ?? "";
    if (input.length > 0 && !input.endsWith("\n")) input += "\n";
    proc.child.stdin?.write(input);
    return proc.result();
  }

  private async signal(spec: SignalSpec): Promise<CallResult> {
    const proc = this.requireNamed(spec.name);
    if (proc.pgid) signalGroup(proc.pgid, (spec.signal || "SIGTERM") as NodeJS.Signals);
    await Promise.race([proc.exitPromise, sleep(KILL_GRACE_MS)]);
    if (!proc.exited && proc.pgid) signalGroup(proc.pgid, "SIGKILL");
    await Promise.race([proc.exitPromise, sleep(500)]);
    return proc.result();
  }

  private async waitFor(spec: WaitForSpec): Promise<CallResult> {
    const { port, host = "127.0.0.1", timeoutMs = 30_000 } = spec.waitFor;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await probePort(host, port)) {
        return {
          exitCode: 0,
          stdout: `port ${port} ready`,
          stderr: "",
          truncated: false,
          bytes: { stdout: 0, stderr: 0 },
          truncatedBytes: { stdout: 0, stderr: 0 },
          durationMs: Date.now() - started,
        };
      }
      await sleep(100);
    }
    throw new ProgramError("CALL_WAIT_TIMEOUT", `等待端口 ${port} 超时。`);
  }

  private async read(spec: ReadSpec): Promise<CallResult> {
    const proc = this.requireNamed(spec.read.name);
    const waitMs = spec.read.waitMs ?? 0;
    if (waitMs > 0) await Promise.race([proc.exitPromise, sleep(waitMs)]);
    return proc.result();
  }

  private async join(spec: JoinSpec): Promise<CallResult> {
    const proc = this.requireNamed(spec.join.name);
    const { timeoutMs } = spec.join;
    const done = await Promise.race([
      proc.settle().then(() => true),
      ...(timeoutMs != null ? [sleep(timeoutMs).then(() => false)] : []),
    ]);
    if (!done) throw new ProgramError("CALL_WAIT_TIMEOUT", `等待进程 ${proc.name} 退出超时。`);
    this.reap(proc);
    return proc.result();
  }

  private reap(proc: Proc): void {
    if (!proc.pgid) return;
    killGroup(proc.pgid);
    this.groups.delete(proc.pgid);
  }

  private requireNamed(name: string): Proc {
    const proc = this.named.get(name);
    if (!proc) throw new ProgramError("CALL_CHILD_UNKNOWN", `未知后台进程：${name}`);
    return proc;
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false; // ESRCH: group already gone
  }
}

/** SIGTERM the group now, SIGKILL it after a grace period if anything is left. */
export function killGroup(pgid: number): void {
  if (!signalGroup(pgid, "SIGTERM")) return;
  setTimeout(() => signalGroup(pgid, "SIGKILL"), KILL_GRACE_MS).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(200);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Ring buffer keeping only the last `cap` bytes. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  total = 0;
  constructor(private readonly cap: number) {}
  get dropped(): number {
    return this.total - this.size;
  }
  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (chunk.length >= this.cap) {
      this.chunks = [chunk.subarray(chunk.length - this.cap)];
      this.size = this.cap;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap) {
      const head = this.chunks[0]!;
      const excess = this.size - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }
  toString(): string {
    const text = Buffer.concat(this.chunks).toString("utf8");
    return this.dropped > 0 ? `/* …前 ${this.dropped} 字节已截断，仅保留末尾 ${this.size} 字节… */\n${text}` : text;
  }
}

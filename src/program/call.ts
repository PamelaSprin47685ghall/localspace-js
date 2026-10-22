import { spawn, type ChildProcess } from "node:child_process";
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

export type CallOpts = { maxOutputBytes?: number };

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
  private parked: Proc | undefined;
  private readonly groups = new Set<number>();

  constructor(private readonly ctx: CallContext) {}

  async call(command: string, opts: CallOpts = {}): Promise<CallResult> {
    if (typeof command !== "string" || !command) {
      throw new ProgramError("CALL_COMMAND_UNSUPPORTED", "this.call 需要一条命令字符串。");
    }
    const proc = this.start(command, opts.maxOutputBytes);
    this.parked = proc;
    await proc.settle();
    const result = proc.result();
    this.reap(proc);
    this.parked = undefined;
    return result;
  }

  async send(input: string): Promise<void> {
    const proc = this.requireParked();
    let text = input ?? "";
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    proc.child.stdin?.write(text);
  }

  async signal(signal: string = "SIGTERM"): Promise<void> {
    const proc = this.requireParked();
    if (proc.pgid) signalGroup(proc.pgid, (signal || "SIGTERM") as NodeJS.Signals);
  }

  takeDelta(): { stdout: string; stderr: string } {
    if (!this.parked) return { stdout: "", stderr: "" };
    return { stdout: this.parked.stdout.take(), stderr: this.parked.stderr.take() };
  }

  /** Kill every process group this hub started (SIGTERM, then SIGKILL). */
  dispose(): void {
    for (const pgid of this.groups) killGroup(pgid);
    this.groups.clear();
    this.parked = undefined;
  }

  private start(command: string, cap?: number): Proc {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: this.ctx.root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group: pgid === pid
    });
    const proc = new Proc(child, undefined, cap ?? STREAM_CAP);
    if (child.pid) this.groups.add(child.pid);
    return proc;
  }

  private reap(proc: Proc): void {
    if (!proc.pgid) return;
    killGroup(proc.pgid);
    this.groups.delete(proc.pgid);
  }

  private requireParked(): Proc {
    const proc = this.parked;
    if (!proc || proc.exited) {
      throw new ProgramError("CALL_CHILD_UNKNOWN", "没有一条仍在跑、并让本次程序 park 的 call。");
    }
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
  setTimeout(() => signalGroup(pgid, "SIGKILL"), KILL_GRACE_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  take(): string {
    const text = Buffer.concat(this.chunks).toString("utf8");
    this.chunks = [];
    this.size = 0;
    return text;
  }
}

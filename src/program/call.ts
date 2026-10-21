import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";
import { ProgramError } from "./errors.js";
import { analyzeCommandDanger, type DangerHit } from "./guard.js";

const STREAM_CAP = 128 * 1024;

export interface CallResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  bytes: { stdout: number; stderr: number };
  durationMs: number;
  name?: string;
}

export interface CallContext {
  deadlineMs: number;
  checkYield: () => Promise<void>;
  requestPark: (kind: "where" | "park" | "confirm" | "yield", payload: unknown) => Promise<unknown>;
  requireDanger: (hit: DangerHit, already: boolean) => Promise<void>;
  resolveCwd: (cwd?: string) => string;
}

type SpawnSpec = { spawn: string; name: string; cwd?: string; env?: Record<string, string>; dangerous?: boolean };
type SendSpec = { send: { name: string; input: string } };
type SignalSpec = { signal: NodeJS.Signals | string; name: string };
type WaitForSpec = { waitFor: { port: number; timeoutMs?: number; host?: string } };
type ReadSpec = { read: { name: string; waitMs?: number } };
type JoinSpec = { join: { name: string; timeoutMs?: number } };
export type CallSpec = string | SpawnSpec | SendSpec | SignalSpec | WaitForSpec | ReadSpec | JoinSpec;

interface ManagedChild {
  name: string;
  command: string;
  child: ChildProcessWithoutNullStreams;
  stdout: HeadTail;
  stderr: HeadTail;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  signal?: string;
  exitWaiters: Array<() => void>;
}

export class CallHub {
  private readonly children = new Map<string, ManagedChild>();

  constructor(private readonly ctx: CallContext) {}

  async call(spec: CallSpec, opts: { cwd?: string; env?: Record<string, string>; dangerous?: boolean; timeoutMs?: number } = {}): Promise<CallResult> {
    await this.ctx.checkYield();
    if (typeof spec === "string") {
      return this.foreground(spec, opts);
    }
    if ("spawn" in spec) return this.spawn(spec);
    if ("send" in spec) return this.send(spec);
    if ("signal" in spec) return this.signal(spec);
    if ("waitFor" in spec) return this.waitFor(spec);
    if ("read" in spec) return this.read(spec);
    if ("join" in spec) return this.join(spec);
    throw new ProgramError("CALL_UNSUPPORTED", "无法识别的 call 参数。");
  }

  dispose(): void {
    for (const managed of this.children.values()) {
      if (!managed.exited) {
        try {
          managed.child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (!managed.exited) {
            try {
              managed.child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
        }, 2000).unref?.();
      }
    }
    this.children.clear();
  }

  private async foreground(
    command: string,
    opts: { cwd?: string; env?: Record<string, string>; dangerous?: boolean; timeoutMs?: number },
  ): Promise<CallResult> {
    const hit = analyzeCommandDanger(command);
    if (hit) await this.ctx.requireDanger(hit, opts.dangerous === true);
    const cwd = this.ctx.resolveCwd(opts.cwd);
    const started = Date.now();
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...process.env, ...envOf(opts.env) },
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
    const stdout = new HeadTail(STREAM_CAP);
    const stderr = new HeadTail(STREAM_CAP);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    let exited = false;
    let exitCode: number | null = null;
    let signal: string | undefined;
    const done = new Promise<void>((resolve, reject) => {
      child.on("error", (error) => reject(new ProgramError("CALL_FAILED", error.message)));
      child.on("close", (code, sig) => {
        exited = true;
        exitCode = code;
        signal = sig ?? undefined;
        resolve();
      });
    });

    const hardDeadline = opts.timeoutMs != null ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;

    while (!exited) {
      if (Date.now() >= hardDeadline) {
        child.kill("SIGKILL");
        await done.catch(() => undefined);
        throw new ProgramError("CALL_TIMEOUT", `命令超时：${command.slice(0, 120)}`);
      }
      if (Date.now() >= this.ctx.deadlineMs) {
        await this.ctx.requestPark("yield", {
          message: "已达自动挂起时限。",
          phase: "call",
          command,
          stdoutTail: stdout.toString().slice(-2000),
          stderrTail: stderr.toString().slice(-2000),
          exited: false,
        });
        // resume: continue waiting
      }
      await Promise.race([done, sleep(100)]);
    }

    return {
      exitCode,
      ...(signal ? { signal } : {}),
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      truncated: stdout.truncated || stderr.truncated,
      bytes: { stdout: stdout.total, stderr: stderr.total },
      durationMs: Date.now() - started,
    };
  }

  private async spawn(spec: SpawnSpec): Promise<CallResult> {
    const name = spec.name?.trim();
    if (!name) throw new ProgramError("CALL_CHILD_UNKNOWN", "spawn 需要 name。");
    if (this.children.has(name) && !this.children.get(name)!.exited) {
      throw new ProgramError("CALL_CHILD_EXISTS", `后台进程已存在：${name}`);
    }
    const hit = analyzeCommandDanger(spec.spawn);
    if (hit) await this.ctx.requireDanger(hit, spec.dangerous === true);
    const cwd = this.ctx.resolveCwd(spec.cwd);
    const started = Date.now();
    const child = spawn("/bin/bash", ["-lc", spec.spawn], {
      cwd,
      env: { ...process.env, ...envOf(spec.env) },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const managed: ManagedChild = {
      name,
      command: spec.spawn,
      child,
      stdout: new HeadTail(STREAM_CAP),
      stderr: new HeadTail(STREAM_CAP),
      startedAt: started,
      exited: false,
      exitCode: null,
      exitWaiters: [],
    };
    child.stdout.on("data", (chunk: Buffer) => managed.stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => managed.stderr.push(chunk));
    child.on("close", (code, sig) => {
      managed.exited = true;
      managed.exitCode = code;
      managed.signal = sig ?? undefined;
      for (const wake of managed.exitWaiters) wake();
      managed.exitWaiters = [];
    });
    child.on("error", () => {
      managed.exited = true;
      managed.exitCode = 1;
      for (const wake of managed.exitWaiters) wake();
      managed.exitWaiters = [];
    });
    this.children.set(name, managed);
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      bytes: { stdout: 0, stderr: 0 },
      durationMs: Date.now() - started,
      name,
    };
  }

  private async send(spec: SendSpec): Promise<CallResult> {
    const managed = this.requireChild(spec.send.name);
    if (managed.exited) throw new ProgramError("CALL_CHILD_UNKNOWN", `进程已退出：${managed.name}`);
    let input = spec.send.input ?? "";
    if (input.length > 0 && !input.endsWith("\n")) input += "\n";
    managed.child.stdin.write(input);
    return snapshot(managed);
  }

  private async signal(spec: SignalSpec): Promise<CallResult> {
    const managed = this.requireChild(spec.name);
    if (!managed.exited) {
      const sig = (spec.signal || "SIGTERM") as NodeJS.Signals;
      managed.child.kill(sig);
      const deadline = Date.now() + 2000;
      while (!managed.exited && Date.now() < deadline) await sleep(50);
      if (!managed.exited) managed.child.kill("SIGKILL");
    }
    return snapshot(managed);
  }

  private async waitFor(spec: WaitForSpec): Promise<CallResult> {
    const port = spec.waitFor.port;
    const host = spec.waitFor.host ?? "127.0.0.1";
    const timeoutMs = spec.waitFor.timeoutMs ?? 30_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await this.ctx.checkYield();
      if (Date.now() >= this.ctx.deadlineMs) {
        await this.ctx.requestPark("yield", {
          message: "等待端口时达自动挂起时限。",
          phase: "waitFor",
          port,
          elapsedMs: Date.now() - started,
        });
      }
      const open = await probePort(host, port);
      if (open) {
        return {
          exitCode: 0,
          stdout: `port ${port} ready`,
          stderr: "",
          truncated: false,
          bytes: { stdout: 0, stderr: 0 },
          durationMs: Date.now() - started,
        };
      }
      await sleep(100);
    }
    throw new ProgramError("CALL_WAIT_TIMEOUT", `等待端口 ${port} 超时。`);
  }

  private async read(spec: ReadSpec): Promise<CallResult> {
    const managed = this.requireChild(spec.read.name);
    const waitMs = spec.read.waitMs ?? 0;
    if (waitMs > 0) {
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        await this.ctx.checkYield();
        if (Date.now() >= this.ctx.deadlineMs) {
          await this.ctx.requestPark("yield", {
            message: "读取后台输出时达自动挂起时限。",
            phase: "read",
            name: managed.name,
          });
        }
        if (managed.exited) break;
        await sleep(50);
      }
    }
    return snapshot(managed);
  }

  private async join(spec: JoinSpec): Promise<CallResult> {
    const managed = this.requireChild(spec.join.name);
    const timeoutMs = spec.join.timeoutMs;
    const started = Date.now();
    while (!managed.exited) {
      await this.ctx.checkYield();
      if (timeoutMs != null && Date.now() - started >= timeoutMs) {
        throw new ProgramError("CALL_WAIT_TIMEOUT", `等待进程 ${managed.name} 退出超时。`);
      }
      if (Date.now() >= this.ctx.deadlineMs) {
        await this.ctx.requestPark("yield", {
          message: "join 等待时达自动挂起时限。",
          phase: "join",
          name: managed.name,
        });
      }
      await new Promise<void>((resolve) => {
        if (managed.exited) return resolve();
        managed.exitWaiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
    return snapshot(managed);
  }

  private requireChild(name: string): ManagedChild {
    const managed = this.children.get(name);
    if (!managed) throw new ProgramError("CALL_CHILD_UNKNOWN", `未知后台进程：${name}`);
    return managed;
  }
}

function snapshot(managed: ManagedChild): CallResult {
  return {
    exitCode: managed.exitCode,
    ...(managed.signal ? { signal: managed.signal } : {}),
    stdout: managed.stdout.toString(),
    stderr: managed.stderr.toString(),
    truncated: managed.stdout.truncated || managed.stderr.truncated,
    bytes: { stdout: managed.stdout.total, stderr: managed.stderr.total },
    durationMs: Date.now() - managed.startedAt,
    name: managed.name,
  };
}

function envOf(env?: Record<string, string>): Record<string, string> {
  return env ?? {};
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

export class HeadTail {
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

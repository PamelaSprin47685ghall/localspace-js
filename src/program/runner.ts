import { Worker } from "node:worker_threads";
import { CallHub } from "./call.js";
import { ProgramError, isProgramError } from "./errors.js";
import { sembleRequest } from "./semble.js";
import { globalParkTable, toView, type ParkKind, type ParkResumeResult, type ParkTable } from "./park.js";
import { RequestWindow } from "./request-window.js";
import type { MainToWorker, ProgramEnd, WorkerInit, WorkerToMain } from "./protocol.js";

export interface RunProgramInput {
  workspaceId: string;
  root: string;
  allowedRoots: string[];
  configDir: string;
  stateDir: string;
  program: string;
  /** 必填工具参数；整个请求及其恢复目标共用 UTF-8 字节数 × 50ms。 */
  planB: string;
  parkTable?: ParkTable;
  /** Aborted when the MCP request is cancelled or its connection drops: the run and its process groups die. */
  signal?: AbortSignal;
}

export type RunProgramResult = ParkResumeResult;

const FROM_SOURCE = import.meta.url.endsWith(".ts");
const WORKER_URL = new URL(FROM_SOURCE ? "./worker.ts" : "./worker.js", import.meta.url);
/** From source (tests/dev under tsx) the worker entry must register tsx before loading worker.ts. */
const WORKER_ENTRY: string | URL = FROM_SOURCE
  ? `import("tsx/esm/api").then((tsx) => tsx.tsImport(${JSON.stringify(WORKER_URL.href)}, ${JSON.stringify(import.meta.url)}))`
  : WORKER_URL;
const WORKER_HEAP_MB = 1024;
const live = new Set<ProgramRun>();

/** Server shutdown: kill every live program, its worker and its process groups. */
export function shutdownPrograms(): void {
  for (const run of [...live]) run.kill(endWith("failed", "SHUTDOWN", "服务关闭，程序已终止。"));
}

export function liveProgramCount(): number {
  return live.size;
}

/** 独立 worker 执行程序；主线程持有一次准入的绝对截止时间。 */
export async function runProgram(input: RunProgramInput): Promise<RunProgramResult> {
  if (typeof input.planB !== "string" || input.planB.length === 0) {
    return { status: "failed", error: { code: "INVALID_ARGUMENT", message: "js 工具顶层 planB 必须是非空字符串；等待时间为 UTF-8 字节数 × 50 ms。" }, written: [] };
  }
  if (input.signal?.aborted) return { status: "failed", error: { code: "CANCELLED", message: "请求已取消，程序未启动。" }, written: [] };
  const window = new RequestWindow(input.planB);
  const run = new ProgramRun(input, input.parkTable ?? globalParkTable, window);
  // The client hung up: the program (and its calls) keep running and stay claimable via park.
  const onAbort = () => run.detach();
  if (input.signal?.aborted) onAbort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await run.wait();
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

type Event = Extract<WorkerToMain, { t: "park" | "end" }>;

class ProgramRun {
  private readonly worker: Worker;
  /** Child processes live on the main thread so they are always reaped and killable. */
  private readonly hub: CallHub;
  private readonly startedAt = Date.now();
  private written: string[] = [];
  private readonly events: Event[] = [];
  private wake?: () => void;
  private dead = false;
  private detached = false;
  private detachedResult?: RunProgramResult;
  private callActive = 0;
  private stopListening?: () => void;
  private readonly admissionWaiters = new Set<() => void>();
  private readonly queuedReplies: Extract<MainToWorker, { t: "reply" }>[] = [];
  private readonly controls = new Map<number, RequestWindow>();

  constructor(
    private readonly input: RunProgramInput,
    private readonly parkTable: ParkTable,
    private window: RequestWindow,
  ) {
    const init: WorkerInit = {
      program: input.program,
      ctx: {
        workspaceId: input.workspaceId,
        root: input.root,
        allowedRoots: input.allowedRoots,
        configDir: input.configDir,
        stateDir: input.stateDir,
      },
    };
    this.hub = new CallHub({ root: input.root });
    this.worker = new Worker(WORKER_ENTRY, {
      workerData: init,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      ...(FROM_SOURCE ? { eval: true } : {}),
      stdout: false,
      stderr: false,
    });
    this.worker.on("message", (msg: WorkerToMain) => void this.onMessage(msg));
    this.worker.on("error", (error: Error) => this.kill(endWith("failed", "WORKER_CRASHED", `程序线程崩溃：${error.message}`)));
    this.worker.on("exit", (code) => this.kill(endWith("failed", "WORKER_EXITED", `程序线程退出（code ${code}）。`)));
    live.add(this);
  }

  /** Wait up to this request's windows for the next park/end; otherwise hand back a yield park. */
  async wait(): Promise<RunProgramResult> {
    if (this.dead && this.events.length === 0) {
      return { status: "failed", error: { code: "PROGRAM_ENDED", message: "程序已经结束。" }, written: [...this.written] };
    }
    const event = await this.next();
    if (!event) {
      return this.detachedResult ?? this.yieldPark();
    }
    if (event.t === "park") {
      this.merge(event.written);
      return this.park(event.kind, event.payload, event.id);
    }
    return this.finish(event.end);
  }

  /**
   * The client disconnected. Do not kill anything: leave a claimable park site so a later js
   * call can unpark this program and collect its result instead of redoing the work.
   */
  detach(): void {
    if (this.dead || this.detached) return;
    this.detached = true;
    this.detachWindow();
    this.detachedResult = this.park("yield", {
      message:
        "客户端已断开；程序及其命令仍在后台运行。下一次 js 请求用 this.unpark(handle) 继续等它结束（顶层 planB 决定等多久），不要重跑命令。",
      elapsedMs: Date.now() - this.startedAt,
      delta: this.hub.takeDelta(),
    });
    this.wake?.();
  }

  /** Terminate the worker and every process group it started. Idempotent. */
  kill(end: ProgramEnd): void {
    if (this.dead) return;
    this.dead = true;
    this.detachWindow();
    live.delete(this);
    this.hub.dispose();
    this.queuedReplies.length = 0;
    this.releaseAdmissions();
    void this.worker.terminate();
    this.push({ t: "end", end });
  }

  private next(): Promise<Event | undefined> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise(resolve => {
      this.wake = () => {
        this.detachWindow();
        this.wake = undefined;
        resolve(this.events.shift());
      };
      this.stopListening = this.window.onExpire(() => {
        if (!this.yieldsThroughTarget()) this.wake?.();
      });
    });
  }

  private detachWindow(): void {
    const stop = this.stopListening;
    this.stopListening = undefined;
    stop?.();
  }

  private yieldsThroughTarget(): boolean {
    return this.controls.size === 1 && this.controls.values().next().value === this.window;
  }

  // 到期后的新操作只排队；只有显式恢复能提供新请求的窗口。
  private async admit<T>(action: (window: RequestWindow) => T | Promise<T>): Promise<T> {
    while (!this.dead) {
      const window = this.window;
      if (window.isOpen()) return action(window);
      await new Promise<void>(resolve => { this.admissionWaiters.add(resolve); });
    }
    throw new ProgramError("ABANDONED", "程序已终止。");
  }
  private releaseAdmissions(): void {
    const waiters = [...this.admissionWaiters];
    this.admissionWaiters.clear();
    for (const resolve of waiters) resolve();
  }
  private deliverReply(reply: Extract<MainToWorker, { t: "reply" }>): void {
    if (this.dead) return;
    if (this.window.isOpen()) this.send(reply);
    else this.queuedReplies.push(reply);
  }
  private useWindow(window: RequestWindow): void {
    this.detachWindow();
    this.detachedResult = undefined;
    this.window = window;
    if (window.isOpen()) {
      while (!this.dead && this.queuedReplies.length && window.isOpen()) this.send(this.queuedReplies.shift()!);
      this.releaseAdmissions();
    }
  }

  private push(event: Event): void {
    if (event.t === "end" && this.events.some((e) => e.t === "end")) return;
    this.events.push(event);
    this.wake?.();
  }

  /** Payload of a request-window expiry: the program (and any call) keeps running in the background. */
  private yieldPark(): RunProgramResult {
    const waitingOnCall = this.callActive > 0;
    return this.park("yield", {
      message: waitingOnCall
        ? `本次 js 请求的共享等待窗口（${this.window.budgetMs} ms）用完，已启动命令仍在后台运行。delta 是新增输出。下一次 js 请求提供顶层 planB，并用 this.unpark(handle) 继续，程序成员不能增加预算。`
        : `本次 js 请求的共享等待窗口（${this.window.budgetMs} ms）用完。下一次 js 请求提供顶层 planB，并用 this.unpark(handle) 继续；全部 call 和 unpark 共用该请求的截止时间。`,
      planB: this.window.planB,
      budgetMs: this.window.budgetMs,
      ...(this.window.capped ? { cappedFromMs: this.window.requestedMs } : {}),
      elapsedMs: Date.now() - this.startedAt,
      delta: this.hub.takeDelta(),
    });
  }

  private park(kind: ParkKind, payload: unknown, resumeId?: number): RunProgramResult {
    const site = this.parkTable.create(
      this.input.workspaceId,
      kind,
      payload,
      async (value, window) => {
        this.useWindow(window);
        if (!this.dead && !window.isOpen()) return this.park(kind, payload, resumeId);
        // A yield never injects the client's argument as the call result: the command keeps
        // running and the worker receives its real CallResult when it exits. Only explicit
        // parks (where/confirm/park) resume by handing `value` back to the program.
        if (kind !== "yield" && resumeId !== undefined && !this.dead) {
          this.send({ t: "resume", id: resumeId, value });
        }
        return this.wait();
      },
      async () => this.kill(endWith("abandoned", "ABANDONED", "现场已放弃")),
      { elapsedMs: Date.now() - this.startedAt, progress: kind === "yield" ? { phase: "yield" } : undefined },
    );
    return { status: "parked", parked: toView(site), written: [...this.written] };
  }

  private finish(end: ProgramEnd): RunProgramResult {
    this.kill(end);
    this.merge(end.written);
    if (end.status === "repark") return { ...end.repark, written: union(this.written, end.repark.written) };
    if (end.status === "done") return { status: "done", value: end.value, written: [...this.written] };
    return { status: end.status, error: end.error, written: [...this.written] };
  }

  private async onMessage(msg: WorkerToMain): Promise<void> {
    if (msg.t === "park" || msg.t === "end") {
      if (msg.t === "end") this.kill(msg.end);
      else this.push(msg);
      return;
    }
    // A malformed message from user code must never take down the server process.
    let reply: Omit<Extract<MainToWorker, { t: "reply" }>, "t" | "id">;
    try {
      reply = await this.admit(window => this.broker(msg, window));
    } catch (error) {
      reply = {
        error: {
          code: isProgramError(error) ? error.code : "BROKER_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.deliverReply({ t: "reply", id: msg.id, ...reply });
  }

  /** this.unpark / this.abandon from inside a program resume another program's park. */
  private async broker(msg: Extract<WorkerToMain, { t: "unpark" | "abandon" | "call" | "semble" | "signal" | "send" }>, window: RequestWindow): Promise<Omit<Extract<MainToWorker, { t: "reply" }>, "t" | "id">> {
    if (msg.t === "semble") {
      if (this.dead) return { error: { code: "ABANDONED", message: "程序已终止。" } };
      try {
        return { value: await sembleRequest(this.input.root, msg.tool, msg.args) };
      } catch (error) {
        return {
          error: isProgramError(error)
            ? { code: error.code, message: error.message }
            : { code: "SEMBLE_FAILED", message: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    if (msg.t === "signal") {
      try {
        await this.hub.signal(msg.signal);
        return {};
      } catch (error) {
        return { error: isProgramError(error) ? { code: error.code, message: error.message } : { code: "SIGNAL_FAILED", message: String(error) } };
      }
    }
    if (msg.t === "send") {
      try {
        await this.hub.send(msg.input);
        return {};
      } catch (error) {
        return { error: isProgramError(error) ? { code: error.code, message: error.message } : { code: "SEND_FAILED", message: String(error) } };
      }
    }
    if (msg.t === "call") {
      if (this.dead) return { error: { code: "ABANDONED", message: "程序已终止。" } };
      this.callActive += 1;
      try {
        // The request window (not this await) decides when the caller gets a park. The worker
        // stays suspended on this promise and receives the real CallResult whenever it arrives.
        return { call: await this.hub.call(msg.command, msg.opts) };
      } catch (error) {
        return {
          error: isProgramError(error)
            ? { code: error.code, message: error.message }
            : { code: "CALL_FAILED", message: error instanceof Error ? error.message : String(error) },
        };
      } finally {
        this.callActive -= 1;
      }
    }
    const taken = this.parkTable.take(msg.handle, this.input.workspaceId);
    if (taken.status === "not_found") return { error: { code: "PARK_NOT_FOUND", message: `找不到挂起现场：${msg.handle}` } };
    if (taken.status === "mismatch") return { error: { code: "PARK_NOT_FOUND", message: `找不到挂起现场：${msg.handle}` } };
    const site = taken.site;
    if (msg.t === "abandon") {
      await site.abandon();
      return {};
    }
    this.controls.set(msg.id, window);
    try {
      const result = await site.resume(msg.value, window);
      if (result.status === "parked") {
        // 沿单一恢复链返回最深目标的真实现场，不能制造竞争的控制者 handle。
        if (this.window === window && this.yieldsThroughTarget() && !window.isOpen()) {
          this.kill({ status: "repark", repark: result, written: [] });
          return {};
        }
        return { repark: result };
      }
      if (result.status === "done") return { value: result.value, written: result.written };
      return { error: result.error ?? { code: "ABANDONED", message: "现场已放弃" } };
    } finally {
      this.controls.delete(msg.id);
      if (!this.dead && !this.window.isOpen() && !this.yieldsThroughTarget()) this.wake?.();
    }
  }

  private send(msg: MainToWorker): void {
    if (!this.dead) this.worker.postMessage(msg);
  }

  private merge(paths: string[]): void {
    this.written = union(this.written, paths);
  }
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function endWith(status: "failed" | "abandoned", code: string, message: string): ProgramEnd {
  return { status, error: { code, message }, written: [] };
}

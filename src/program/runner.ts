import { Worker } from "node:worker_threads";
import { CallHub } from "./call.js";
import { isProgramError } from "./errors.js";
import { sembleRequest } from "./semble.js";
import { globalParkTable, toView, type ParkKind, type ParkResumeResult, type ParkTable } from "./park.js";
import type { MainToWorker, ProgramEnd, WorkerInit, WorkerToMain } from "./protocol.js";

export interface RunProgramInput {
  workspaceId: string;
  root: string;
  allowedRoots: string[];
  configDir: string;
  stateDir: string;
  program: string;
  yieldBudgetMs?: number;
  /** Echoed back in the yield park so the model rereads its own alternative. */
  planB?: string;
  parkTable?: ParkTable;
  /** Aborted when the MCP request is cancelled or its connection drops: the run and its process groups die. */
  signal?: AbortSignal;
}

export type RunProgramResult = ParkResumeResult;

/** One `js` request may run this long outside `this.call`; call time is free. */
export const REQUEST_WINDOW_MS = 1000;
/** A `this.call` without planB gets exactly this long before it yields. */
export const CALL_WINDOW_MS = 1000;

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

/**
 * Run a program in its own worker thread. The main thread only brokers messages and keeps time:
 * once the request window (REQUEST_WINDOW_MS of program time, excluding `this.call` waits) is
 * spent, the request returns a yield park no matter what the program is doing (busy loop,
 * never-resolving promise). `yieldBudgetMs` exists for tests that need a wider window.
 */
export async function runProgram(input: RunProgramInput): Promise<RunProgramResult> {
  const run = new ProgramRun(input, input.parkTable ?? globalParkTable);
  const onAbort = () => run.kill(endWith("failed", "CANCELLED", "请求已取消，程序及其进程组已终止。"));
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
  private planB?: string;
  /** Program-time window for this request; call waiting is billed separately. */
  private budgetMs = REQUEST_WINDOW_MS;
  /** How long this request is willing to wait on the active call: the call's planB (bytes × 50ms), else 1s. */
  private callWaitBudgetMs = CALL_WINDOW_MS;
  /** Window bookkeeping: call time is excluded from the request window. */
  private windowStartedAt = Date.now();
  private callWaitMs = 0;
  private callActive = 0;
  private callStartedAt?: number;
  private windowTimer?: NodeJS.Timeout;

  constructor(
    private readonly input: RunProgramInput,
    private readonly parkTable: ParkTable,
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
    this.planB = input.planB;
    this.budgetMs = input.yieldBudgetMs ?? REQUEST_WINDOW_MS;
    live.add(this);
  }

  /** Wait up to this request's windows for the next park/end; otherwise hand back a yield park. */
  async wait(): Promise<RunProgramResult> {
    const event = await this.next();
    if (!event) {
      return this.yieldPark();
    }
    if (event.t === "park") {
      this.merge(event.written);
      return this.park(event.kind, event.payload, event.id);
    }
    return this.finish(event.end);
  }

  /** Terminate the worker and every process group it started. Idempotent. */
  kill(end: ProgramEnd): void {
    if (this.dead) return;
    this.dead = true;
    this.clearWindowTimer();
    live.delete(this);
    this.hub.dispose();
    void this.worker.terminate();
    this.push({ t: "end", end });
  }

  private next(): Promise<Event | undefined> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.wake = () => {
        this.clearWindowTimer();
        this.wake = undefined;
        resolve(this.events.shift());
      };
      this.armWindow();
    });
  }

  private remainingWindowMs(): number {
    const now = Date.now();
    if (this.callActive > 0) {
      // Call time is billed to the call's own planB window, never to the 1s program window.
      return Math.max(0, this.callWaitBudgetMs - (now - (this.callStartedAt ?? now)));
    }
    return Math.max(0, this.budgetMs - (now - this.windowStartedAt - this.callWaitMs));
  }

  /** The window timer is never absent: every request must end in a park or an end event. */
  private armWindow(): void {
    this.clearWindowTimer();
    if (!this.wake) return;
    this.windowTimer = setTimeout(() => {
      this.windowTimer = undefined;
      this.wake?.();
    }, Math.max(0, this.remainingWindowMs()));
  }

  private clearWindowTimer(): void {
    if (this.windowTimer !== undefined) {
      clearTimeout(this.windowTimer);
      this.windowTimer = undefined;
    }
  }

  private beginCall(waitMs: number, planB: string | undefined): void {
    if (this.callActive === 0) {
      this.callStartedAt = Date.now();
      this.callWaitBudgetMs = waitMs;
      this.planB = planB;
    }
    this.callActive += 1;
    this.armWindow();
  }

  private endCall(): void {
    if (this.callActive === 0) return;
    this.callActive -= 1;
    if (this.callActive === 0) {
      this.callWaitMs += Date.now() - (this.callStartedAt ?? Date.now());
      this.callStartedAt = undefined;
      this.armWindow();
    }
  }

  /** A resumed program gets a fresh 1s program window plus the wait budget its unpark bought. */
  private resetWindow(waitBudgetMs?: number): void {
    const now = Date.now();
    this.windowStartedAt = now;
    this.callWaitMs = 0;
    if (waitBudgetMs !== undefined) this.callWaitBudgetMs = waitBudgetMs;
    if (this.callActive > 0) this.callStartedAt = now;
    this.armWindow();
  }

  private push(event: Event): void {
    if (event.t === "end" && this.events.some((e) => e.t === "end")) return;
    this.events.push(event);
    this.wake?.();
  }

  /** Payload of a request-window expiry: the program (and any call) keeps running in the background. */
  private yieldPark(): RunProgramResult {
    const waitingOnCall = this.callActive > 0;
    const budgetMs = waitingOnCall ? this.callWaitBudgetMs : this.budgetMs;
    return this.park("yield", {
      message: waitingOnCall
        ? `call 的等待窗口（${budgetMs} ms）用完了，命令仍在后台运行。delta 是自上次 park 以来的新输出；用 this.unpark(handle, undefined, planB) 继续等它结束，planB 决定这次愿意等多久。`
        : `本次请求的等待窗口（${budgetMs} ms）用完，程序仍在后台运行。delta 是自上次 park 以来的新输出；用 this.unpark(handle, undefined, planB) 继续等它结束，planB 决定这次愿意等多久。`,
      ...(this.planB === undefined ? {} : { planB: this.planB }),
      budgetMs,
      elapsedMs: Date.now() - this.startedAt,
      delta: this.hub.takeDelta(),
    });
  }

  private park(kind: ParkKind, payload: unknown, resumeId?: number): RunProgramResult {
    const site = this.parkTable.create(
      this.input.workspaceId,
      kind,
      payload,
      async (value, waitBudgetMs) => {
        this.resetWindow(waitBudgetMs);
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
      reply = await this.broker(msg);
    } catch (error) {
      reply = {
        error: {
          code: isProgramError(error) ? error.code : "BROKER_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.send({ t: "reply", id: msg.id, ...reply });
  }

  /** this.unpark / this.abandon from inside a program resume another program's park. */
  private async broker(msg: Extract<WorkerToMain, { t: "unpark" | "abandon" | "call" | "semble" | "signal" | "send" }>): Promise<Omit<Extract<MainToWorker, { t: "reply" }>, "t" | "id">> {
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
      const wait = planBWaitMs(msg.planB);
      if ("error" in wait) return wait;
      const call = this.hub.call(msg.command, msg.opts);
      this.beginCall(wait.ms, typeof msg.planB === "string" ? msg.planB : undefined);
      try {
        // The request window (not this await) decides when the caller gets a park. The worker
        // stays suspended on this promise and receives the real CallResult whenever it arrives.
        return { call: await call };
      } catch (error) {
        return {
          error: isProgramError(error)
            ? { code: error.code, message: error.message }
            : { code: "CALL_FAILED", message: error instanceof Error ? error.message : String(error) },
        };
      } finally {
        this.endCall();
      }
    }
    const taken = this.parkTable.take(msg.handle, this.input.workspaceId);
    if (taken.status === "not_found") {
      return { error: { code: "PARK_NOT_FOUND", message: `找不到挂起现场：${msg.handle}（已过期或已处理）。` } };
    }
    if (taken.status === "mismatch") {
      // Never reveal that another workspace holds this handle: separate agents run in separate
      // workspaces, and the caller has no business knowing about them. The site stays untouched.
      return { error: { code: "PARK_NOT_FOUND", message: `找不到挂起现场：${msg.handle}（已过期或已处理）。` } };
    }
    const site = taken.site;
    if (msg.t === "abandon") {
      await site.abandon();
      return {};
    }
    const wait = planBWaitMs(msg.planB);
    if ("error" in wait) return wait;
    // Resuming waits on the other program: this request is billed by its own planB, not by the
    // 1s compute window, so `unpark(handle, undefined, planB)` can wait as long as it asked for.
    this.beginCall(wait.ms, typeof msg.planB === "string" ? msg.planB : undefined);
    let result: ParkResumeResult;
    try {
      result = await site.resume(msg.value, wait.ms);
    } finally {
      this.endCall();
    }
    if (result.status === "parked") return { repark: result };
    if (result.status === "done") return { value: result.value, written: result.written };
    return { error: result.error ?? { code: "ABANDONED", message: "现场已放弃" } };
  }

  private send(msg: MainToWorker): void {
    if (!this.dead) this.worker.postMessage(msg);
  }

  private merge(paths: string[]): void {
    this.written = union(this.written, paths);
  }
}

/** planB is user input: bytes x 50ms, 1s when omitted, a clean error otherwise. */
function planBWaitMs(planB: unknown): { ms: number } | { error: { code: string; message: string } } {
  if (planB === undefined) return { ms: CALL_WINDOW_MS };
  if (typeof planB !== "string" || !planB) {
    return {
      error: {
        code: "INVALID_ARGUMENT",
        message: `planB 必须是非空字符串（收到 ${typeof planB}）；省略时这条请求等 1 秒。`,
      },
    };
  }
  return { ms: Buffer.byteLength(planB, "utf8") * 50 };
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function endWith(status: "failed" | "abandoned", code: string, message: string): ProgramEnd {
  return { status, error: { code, message }, written: [] };
}

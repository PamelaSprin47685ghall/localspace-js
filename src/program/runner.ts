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
 * after `yieldBudgetMs` (bought with planB bytes) the request returns a yield park no matter what the program is doing
 * (busy loop, never-resolving promise, long call).
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
  private budgetMs?: number;

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
    this.budgetMs = input.yieldBudgetMs;
    live.add(this);
  }

  /** Wait up to the budget for the next park/end; otherwise hand back a yield park. */
  async wait(): Promise<RunProgramResult> {
    const event = await this.next();
    if (!event) {
      return this.park("yield", {
        message: `本次请求的等待窗口（${this.budgetMs ?? "∞"} ms）用完，程序仍在后台运行。delta 是自上次 park 以来的新输出；用 this.unpark(handle) 继续等它结束。`,
        planB: this.planB,
        budgetMs: this.budgetMs,
        elapsedMs: Date.now() - this.startedAt,
        delta: this.hub.takeDelta(),
      });
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
    live.delete(this);
    this.hub.dispose();
    void this.worker.terminate();
    this.push({ t: "end", end });
  }

  private next(): Promise<Event | undefined> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const budgetMs = this.budgetMs;
      const timer = budgetMs === undefined ? undefined : setTimeout(() => {
        this.wake = undefined;
        resolve(undefined);
      }, budgetMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve(this.events.shift());
      };
    });
  }

  private push(event: Event): void {
    if (event.t === "end" && this.events.some((e) => e.t === "end")) return;
    this.events.push(event);
    this.wake?.();
  }

  private park(kind: ParkKind, payload: unknown, resumeId?: number): RunProgramResult {
    const site = this.parkTable.create(
      this.input.workspaceId,
      kind,
      payload,
      async (value, budgetMs) => {
        this.budgetMs = budgetMs;
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
    this.send({ t: "reply", id: msg.id, ...(await this.broker(msg)) });
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
      const budgetMs = Buffer.byteLength(msg.planB, "utf8") * 50;
      const call = this.hub.call(msg.command, msg.opts);
      const expired = Promise.withResolvers<"yield">();
      const timer = setTimeout(() => expired.resolve("yield"), budgetMs);
      timer.unref();
      let outcome: Awaited<typeof call> | "yield";
      try {
        outcome = await Promise.race([call, expired.promise]);
      } catch (error) {
        return {
          error: isProgramError(error)
            ? { code: error.code, message: error.message }
            : { code: "CALL_FAILED", message: error instanceof Error ? error.message : String(error) },
        };
      } finally {
        clearTimeout(timer);
      }
      if (outcome !== "yield") return { call: outcome };
      const delta = this.hub.takeDelta();
      this.push({
        t: "park",
        id: msg.id,
        kind: "yield",
        payload: {
          message: "planB 买的时间用完了，命令仍在后台运行。this.unpark(handle) 继续等它结束；不会丢失输出。",
          planB: msg.planB,
          budgetMs,
          delta,
        },
        written: [...this.written],
      });
      // Keep the call alive and deliver its real result once it exits, so a resumed
      // program sees the full CallResult (stdout/stderr/exitCode) instead of the park arg.
      void call.then(
        (result) => this.send({ t: "reply", id: msg.id, call: result }),
        (error) =>
          this.send({
            t: "reply",
            id: msg.id,
            error: isProgramError(error)
              ? { code: error.code, message: error.message }
              : { code: "CALL_FAILED", message: error instanceof Error ? error.message : String(error) },
          }),
      );
      return new Promise(() => {});
    }
    const site = this.parkTable.take(msg.handle);
    if (!site) return { error: { code: "PARK_NOT_FOUND", message: `找不到挂起现场：${msg.handle}` } };
    if (site.workspaceId !== this.input.workspaceId) {
      return { error: { code: "PARK_WORKSPACE_MISMATCH", message: "挂起现场不属于当前工作区。" } };
    }
    if (msg.t === "abandon") {
      await site.abandon();
      return {};
    }
    const result = await site.resume(msg.value, this.budgetMs);
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

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function endWith(status: "failed" | "abandoned", code: string, message: string): ProgramEnd {
  return { status, error: { code, message }, written: [] };
}

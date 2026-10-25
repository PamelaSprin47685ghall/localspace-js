// Runs one user program off the main thread. The main thread owns budget, parks and process-group cleanup.
import { parentPort, workerData } from "node:worker_threads";
import { createProgramApi } from "./api.js";
import { ProgramError, isProgramError } from "./errors.js";
import type { CallResult } from "./call.js";
import type { ParkResumeResult } from "./park.js";
import type { MainToWorker, ProgramEnd, WorkerInit, WorkerToMain } from "./protocol.js";

const MAX_RESULT_BYTES = 1024 * 1024;
const init = workerData as WorkerInit;
const port = parentPort!;
const written: string[] = [];
const post = (msg: WorkerToMain) => port.postMessage(msg);

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const ask = (msg: (id: number) => WorkerToMain) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    post(msg(id));
  });

port.on("message", (msg: MainToWorker) => {
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.t === "resume") waiter.resolve(msg.value);
  else if (msg.t === "reply") {
    if (msg.error) waiter.reject(new ProgramError(msg.error.code, msg.error.message));
    else if (msg.repark) waiter.reject(new Repark(msg.repark));
    else if (msg.call) waiter.resolve(msg.call);
    else {
      for (const path of msg.written ?? []) if (!written.includes(path)) written.push(path);
      waiter.resolve(msg.value);
    }
  }
});

class Repark extends Error {
  constructor(readonly result: ParkResumeResult) {
    super("REPARK");
  }
}

const surface = createProgramApi({
  ...init.ctx,
  written,
  requestPark: (kind, payload) => ask((id) => ({ t: "park", id, kind, payload, written: [...written] })),
  runCall: (command, opts) => ask((id) => ({ t: "call", id, command, opts })) as Promise<CallResult>,
  signalParked: (signal) => ask((id) => ({ t: "signal", id, signal })) as Promise<void>,
  sendParked: (input) => ask((id) => ({ t: "send", id, input })) as Promise<void>,
  runSemble: (tool, args) => ask((id) => ({ t: "semble", id, tool, args })),
});

// 万象术风格：全部原语挂在 this 上（this.cat / this.call / this.unpark …）
const api = {
  ...surface,
  unpark(handle: string, value?: unknown) {
    if (arguments.length < 1 || arguments.length > 2)
      throw new ProgramError("INVALID_ARGUMENT", "unpark(handle, value?) 最多接受两个参数；等待预算来自 js 工具顶层 intent。");
    if (typeof handle !== "string" || !handle)
      throw new ProgramError("INVALID_ARGUMENT", "unpark 的 handle 必须是非空字符串。");
    return ask(id => ({ t: "unpark", id, handle, value }));
  },
  abandon: async (handle: string) => {
    await ask((id) => ({ t: "abandon", id, handle }));
  },
};

async function main(): Promise<ProgramEnd> {
  try {
    const value = await executeProgram(init.program, api);
    assertJsonCompatible(value ?? null);
    const size = Buffer.byteLength(JSON.stringify(value ?? null));
    if (size > MAX_RESULT_BYTES) {
      throw new ProgramError(
        "RESULT_TOO_LARGE",
        `返回值过大（${size} 字节 > ${MAX_RESULT_BYTES}）。请只返回摘要/切片，大内容写入文件后返回路径。`,
      );
    }
    return { status: "done", value: value ?? null, written: [...written] };
  } catch (error) {
    if (error instanceof Repark) return { status: "repark", repark: error.result, written: [...written] };
    if (isProgramError(error)) {
      return {
        status: error.code === "ABANDONED" ? "abandoned" : "failed",
        error: { code: error.code, message: error.message },
        written: [...written],
      };
    }
    return {
      status: "failed",
      error: { code: "PROGRAM_ERROR", message: error instanceof Error ? error.message : String(error) },
      written: [...written],
    };
  }
}

void main().then((end) => post({ t: "end", end }));

async function executeProgram(source: string, self: Record<string, unknown>): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (this: unknown) => Promise<unknown>;
  let fn: (this: unknown) => Promise<unknown>;
  try {
    fn = new AsyncFunction(`"use strict";\n${source}`);
  } catch (error) {
    throw new ProgramError("PROGRAM_SYNTAX", `程序语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
  return fn.call(self);
}

function assertJsonCompatible(value: unknown, path = "return"): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonCompatible(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) assertJsonCompatible(child, `${path}.${key}`);
    }
    return;
  }
  throw new ProgramError("INVALID_RETURN_VALUE", `返回值不是 JSON 兼容类型：${path}`);
}

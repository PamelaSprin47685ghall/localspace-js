import { ProgramError, isProgramError } from "./errors.js";
import { createProgramApi } from "./api.js";
import { globalParkTable, toView, type ParkResumeResult, type ParkTable } from "./park.js";

export interface RunProgramInput {
  workspaceId: string;
  root: string;
  allowedRoots: string[];
  configDir: string;
  stateDir: string;
  program: string;
  yieldBudgetMs?: number;
  parkTable?: ParkTable;
}

export type RunProgramResult = ParkResumeResult;

function assertJsonCompatible(value: unknown, path = "return"): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonCompatible(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      assertJsonCompatible(child, `${path}.${key}`);
    }
    return;
  }
  throw new ProgramError("INVALID_RETURN_VALUE", `返回值不是 JSON 兼容类型：${path}`);
}

export async function runProgram(input: RunProgramInput): Promise<RunProgramResult> {
  const parkTable = input.parkTable ?? globalParkTable;
  const yieldBudgetMs = input.yieldBudgetMs ?? 30_000;
  const written: string[] = [];
  const startedAt = Date.now();
  let deadlineMs = startedAt + yieldBudgetMs;

  let parkedKind: "where" | "park" | "confirm" | "yield" | undefined;
  let parkedPayload: unknown;
  let parkWaiter: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | undefined;

  let finalize!: (result: RunProgramResult) => void;
  const outcomePromise = new Promise<RunProgramResult>((resolve) => {
    finalize = resolve;
  });

  const requestPark = (kind: "where" | "park" | "confirm" | "yield", payload: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      parkedKind = kind;
      parkedPayload = payload;
      parkWaiter = { resolve, reject };
    });

  const checkYield = async () => {
    if (Date.now() >= deadlineMs) {
      await requestPark("yield", {
        message: "已达 30 秒自动挂起。",
        elapsedMs: Date.now() - startedAt,
      });
    }
  };

  const ctx = {
    workspaceId: input.workspaceId,
    root: input.root,
    allowedRoots: input.allowedRoots,
    configDir: input.configDir,
    stateDir: input.stateDir,
    written,
    requestPark,
    deadlineMs,
    checkYield,
  };

  const apiCore = createProgramApi(ctx);
  const { dispose, ...apiSurface } = apiCore as typeof apiCore & { dispose: () => void };

  const unpark = async (handle: string, value?: unknown): Promise<unknown> => {
    const site = parkTable.take(handle);
    if (!site) throw new ProgramError("PARK_NOT_FOUND", `找不到挂起现场：${handle}`);
    if (site.workspaceId !== input.workspaceId) {
      throw new ProgramError("PARK_WORKSPACE_MISMATCH", "挂起现场不属于当前工作区。");
    }
    const result = await site.resume(value);
    if (result.status === "parked") {
      throw Object.assign(new Error("REPARK"), { repark: result });
    }
    if (result.status === "failed") {
      throw new ProgramError(result.error?.code ?? "RESUME_FAILED", result.error?.message ?? "恢复失败");
    }
    if (result.status === "abandoned") {
      throw new ProgramError("ABANDONED", "现场已放弃");
    }
    for (const path of result.written) {
      if (!written.includes(path)) written.push(path);
    }
    return result.value;
  };

  const abandon = async (handle: string): Promise<void> => {
    const site = parkTable.take(handle);
    if (!site) throw new ProgramError("PARK_NOT_FOUND", `找不到挂起现场：${handle}`);
    await site.abandon();
  };

  // 万象术风格：全部原语挂在 this 上（this.cat / this.call / this.unpark …）
  const api = { ...apiSurface, unpark, abandon };

  const settle = (result: RunProgramResult): RunProgramResult => {
    if (result.status !== "parked") dispose();
    finalize(result);
    return result;
  };

  const execPromise = (async (): Promise<RunProgramResult> => {
    try {
      const value = await executeProgram(input.program, api);
      assertJsonCompatible(value ?? null);
      return settle({ status: "done", value: value ?? null, written: [...written] });
    } catch (error) {
      if ((error as { repark?: RunProgramResult }).repark) {
        // 本 program 仅转发他人的再次挂起；本 hub 可释放
        dispose();
        const result = (error as { repark: RunProgramResult }).repark;
        finalize(result);
        return result;
      }
      if (isProgramError(error)) {
        return settle({
          status: error.code === "ABANDONED" ? "abandoned" : "failed",
          error: { code: error.code, message: error.message },
          written: [...written],
        });
      }
      return settle({
        status: "failed",
        error: {
          code: "PROGRAM_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
        written: [...written],
      });
    }
  })();

  function emitPark(
    kind: "where" | "park" | "confirm" | "yield",
    payload: unknown,
    waiter: { resolve: (value: unknown) => void; reject: (error: unknown) => void },
  ): RunProgramResult {
    const site = parkTable.create(
      input.workspaceId,
      kind,
      payload,
      async (value) => {
        deadlineMs = Date.now() + yieldBudgetMs;
        ctx.deadlineMs = deadlineMs;
        waiter.resolve(value);
        while (true) {
          if (parkedKind && parkWaiter) {
            const reKind = parkedKind!;
            const rePayload = parkedPayload;
            const reWaiter = parkWaiter!;
            parkedKind = undefined;
            parkedPayload = undefined;
            parkWaiter = undefined;
            return emitPark(reKind, rePayload, reWaiter);
          }
          const settled = await raceSettled(outcomePromise, 20);
          if (settled) return settled;
        }
      },
      async () => {
        waiter.reject(new ProgramError("ABANDONED", "现场已放弃"));
        dispose();
        finalize({
          status: "abandoned",
          error: { code: "ABANDONED", message: "现场已放弃" },
          written: [...written],
        });
      },
      {
        elapsedMs: Date.now() - startedAt,
        progress: kind === "yield" ? { phase: "yield" } : undefined,
      },
    );
    return { status: "parked", parked: toView(site), written: [...written] };
  }

  while (true) {
    if (parkedKind && parkWaiter) {
      const kind = parkedKind;
      const payload = parkedPayload;
      const waiter = parkWaiter;
      parkedKind = undefined;
      parkedPayload = undefined;
      parkWaiter = undefined;

      return emitPark(kind, payload, waiter);
    }

    const settled = await raceSettled(execPromise, 20);
    if (settled) return settled;
  }

}

async function raceSettled<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let done = false;
  let value: T | undefined;
  void promise.then(
    (result) => {
      done = true;
      value = result;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return done ? value : undefined;
}

async function executeProgram(
  source: string,
  api: Record<string, unknown>,
): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    // 程序体挂在 this 上：this.cat / this.call / this.unpark …
    fn = new AsyncFunction(`"use strict";\n${source}`);
  } catch (error) {
    throw new ProgramError(
      "PROGRAM_SYNTAX",
      `程序语法错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return fn.call(api);
}

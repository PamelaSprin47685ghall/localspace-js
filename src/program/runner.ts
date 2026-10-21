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

  const api = { ...apiCore, unpark, abandon };

  const execPromise = (async (): Promise<RunProgramResult> => {
    try {
      const value = await executeProgram(input.program, api);
      assertJsonCompatible(value ?? null);
      const result: RunProgramResult = { status: "done", value: value ?? null, written: [...written] };
      finalize(result);
      return result;
    } catch (error) {
      if ((error as { repark?: RunProgramResult }).repark) {
        const result = (error as { repark: RunProgramResult }).repark;
        finalize(result);
        return result;
      }
      if (isProgramError(error)) {
        const result: RunProgramResult = {
          status: error.code === "ABANDONED" ? "abandoned" : "failed",
          error: { code: error.code, message: error.message },
          written: [...written],
        };
        finalize(result);
        return result;
      }
      const result: RunProgramResult = {
        status: "failed",
        error: {
          code: "PROGRAM_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
        written: [...written],
      };
      finalize(result);
      return result;
    }
  })();

  while (true) {
    if (parkedKind && parkWaiter) {
      const kind = parkedKind;
      const payload = parkedPayload;
      const waiter = parkWaiter;
      parkedKind = undefined;
      parkedPayload = undefined;
      parkWaiter = undefined;

      const site = parkTable.create(
        input.workspaceId,
        kind,
        payload,
        async (value) => {
          deadlineMs = Date.now() + yieldBudgetMs;
          ctx.deadlineMs = deadlineMs;
          waiter.resolve(value);
          return outcomePromise;
        },
        async () => {
          waiter.reject(new ProgramError("ABANDONED", "现场已放弃"));
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
  const names = Object.keys(api);
  const values = names.map((name) => api[name]);
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction(...names, `"use strict";\n${source}`);
  } catch (error) {
    throw new ProgramError(
      "PROGRAM_SYNTAX",
      `程序语法错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return fn(...values);
}

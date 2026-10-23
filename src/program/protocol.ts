import type { CallOpts, CallResult } from "./call.js";
import type { ParkResumeResult } from "./park.js";

/** Data a worker needs to build the program API (all structured-clonable). */
export interface WorkerInit {
  program: string;
  ctx: { workspaceId: string; root: string; allowedRoots: string[]; configDir: string; stateDir: string };
}

export type ProgramEnd =
  | { status: "done"; value: unknown; written: string[] }
  | { status: "failed" | "abandoned"; error: { code: string; message: string }; written: string[] }
  /** The program's this.unpark() hit another park; that park becomes this program's result. */
  | { status: "repark"; repark: ParkResumeResult; written: string[] };

export type WorkerToMain =
  | { t: "park"; id: number; kind: "yield" | "where" | "park" | "confirm"; payload: unknown; written: string[] }
  | { t: "unpark"; id: number; handle: string; value: unknown }
  | { t: "abandon"; id: number; handle: string }
  | { t: "call"; id: number; command: string; planB: string; opts: CallOpts }
  | { t: "signal"; id: number; signal?: string }
  | { t: "send"; id: number; input: string }
  | { t: "end"; end: ProgramEnd };

export type MainToWorker =
  | { t: "resume"; id: number; value: unknown }
  | {
      t: "reply";
      id: number;
      value?: unknown;
      written?: string[];
      repark?: ParkResumeResult;
      call?: CallResult;
      error?: { code: string; message: string };
    };

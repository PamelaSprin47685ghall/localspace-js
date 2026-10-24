// Process-level guard: one stray rejection must not take the whole MCP server down.
// Node's default is to exit on an unhandled rejection; every request handler and worker
// message path is async, so a single missed catch used to kill the service (and every
// live program with it) while a client was mid-conversation.
import { logEvent, type LoggingConfig } from "./logger.js";

export interface ProcessGuardOptions {
  logging: LoggingConfig;
  /** Called after the error is recorded; used by tests. */
  onError?: (kind: string, error: unknown) => void;
}

const installed = new WeakSet<object>();

export function installProcessGuards(options: ProcessGuardOptions): void {
  const target = process as unknown as object;
  if (installed.has(target)) return;
  installed.add(target);

  const record = (kind: string, error: unknown) => {
    logEvent(options.logging, "error", kind, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    options.onError?.(kind, error);
  };

  process.on("unhandledRejection", (reason) => record("unhandled_rejection", reason));
  process.on("uncaughtException", (error) => record("uncaught_exception", error));
}

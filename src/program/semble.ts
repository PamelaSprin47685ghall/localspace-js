// Built-in Semble code search over MCP stdio. One long-lived child per workspace root,
// spawned directly from uvx; requests are async so indexing never blocks the main thread.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProgramError } from "./errors.js";

export type SembleTool = "search" | "find_related";
export type SembleContent = "code" | "docs" | "config" | "all";

/** Hard wall-clock limit for one tool call (first call also downloads the package + builds an index). */
const DEFAULT_CALL_TIMEOUT_MS = 300_000;
const INIT_TIMEOUT_MS = 180_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const MAX_STDERR = 8 * 1024;
const MAX_CLIENTS = 4;
/** MCP handshake version; the Python SDK negotiates down if it only knows an older one. */
const PROTOCOL_VERSION = "2025-06-18";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** `LOCALSPACE_SEMBLE_CMD` accepts a JSON array (exact argv) or whitespace-separated words. */
function sembleCommand(): string[] {
  const raw = process.env.LOCALSPACE_SEMBLE_CMD?.trim();
  if (!raw) return ["uvx", "--from", "semble[mcp]", "semble"];
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => typeof s === "string")) {
        return parsed as string[];
      }
    } catch {
      // fall through to whitespace splitting
    }
  }
  return raw.split(/\s+/);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class SembleClient {
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";
  private init?: Promise<void>;
  private idle?: NodeJS.Timeout;
  private disposed = false;
  busy = 0;
  lastUsed = Date.now();

  constructor(private readonly root: string) {}

  /** One MCP `tools/call`; the workspace root is always bound as `repo`. */
  async request(tool: SembleTool, args: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new ProgramError("SEMBLE_UNAVAILABLE", "Semble 客户端已关闭，请重试。");
    this.touch();
    await this.start();
    this.busy += 1;
    try {
      const params = { name: tool, arguments: { ...args, repo: this.root } };
      const result = await this.rpc("tools/call", params, envInt("LOCALSPACE_SEMBLE_TIMEOUT_MS", DEFAULT_CALL_TIMEOUT_MS));
      return this.readResult(result);
    } finally {
      this.busy -= 1;
      this.touch();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    if (child && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const hard = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 2_000);
      hard.unref();
    }
    this.failAll(new ProgramError("SEMBLE_UNAVAILABLE", "Semble 客户端已关闭。"));
  }

  private touch(): void {
    this.lastUsed = Date.now();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dispose(), envInt("LOCALSPACE_SEMBLE_IDLE_MS", DEFAULT_IDLE_MS));
    this.idle.unref();
  }

  private start(): Promise<void> {
    this.init ??= this.handshake().catch((error: unknown) => {
      // A failed handshake must not poison later attempts: drop the child and allow a fresh spawn.
      this.init = undefined;
      this.dispose();
      throw error;
    });
    return this.init;
  }

  private async handshake(): Promise<void> {
    const [command, ...args] = sembleCommand();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: process.env,
      });
    } catch (error) {
      throw new ProgramError(
        "SEMBLE_UNAVAILABLE",
        `无法启动 ${command}：${error instanceof Error ? error.message : String(error)}。请先安装 uv/uvx（见 README）。`,
      );
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
    });
    child.on("error", (error) => {
      this.failAll(
        new ProgramError(
          "SEMBLE_UNAVAILABLE",
          `无法启动 ${command}：${error.message}。请先安装 uv/uvx（见 README）。${this.stderrTail()}`,
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (this.disposed) return;
      this.failAll(
        new ProgramError(
          "SEMBLE_EXITED",
          `Semble 进程退出（${signal ?? code}）。${this.stderrTail()}`,
        ),
      );
    });
    await this.rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "localspace", version: "1" },
      },
      INIT_TIMEOUT_MS,
    );
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.disposed) {
      return Promise.reject(new ProgramError("SEMBLE_UNAVAILABLE", "Semble 进程未启动。"));
    }
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProgramError("SEMBLE_TIMEOUT", `Semble ${method} 超过 ${timeoutMs} ms 未返回。`));
        // A timed-out index build can leave the child wedged; restart it on the next request.
        this.dispose();
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new ProgramError("SEMBLE_UNAVAILABLE", "Semble 进程不可写。");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: {
        id?: number;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // uvx/venv chatter on stdout
      }
      if (typeof message.id !== "number") continue; // server notifications
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(
          new ProgramError("SEMBLE_FAILED", message.error.message ?? `Semble 错误 ${message.error.code ?? ""}`.trim()),
        );
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  /** Unwrap MCP content blocks: tool results are JSON strings (or plain error text). */
  private readResult(result: unknown): unknown {
    if (!isRecord(result)) return result ?? null;
    const blocks = result.content;
    if (!Array.isArray(blocks)) return result;
    const text = blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join("\n");
    if (result.isError === true) {
      throw new ProgramError("SEMBLE_FAILED", text || "Semble 工具调用失败。");
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private stderrTail(): string {
    const tail = this.stderr.trim().split("\n").slice(-3).join(" | ");
    return tail ? ` stderr: ${tail}` : "";
  }

  private failAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(id);
    }
  }
}

const clients = new Map<string, SembleClient>();

/** Route one search/find_related call to this workspace's long-lived Semble process. */
export function sembleRequest(
  root: string,
  tool: SembleTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  let client = clients.get(root);
  if (!client) {
    while (clients.size >= MAX_CLIENTS) {
      const idle = [...clients.entries()].find(([, c]) => c.busy === 0);
      if (!idle) break;
      idle[1].dispose();
      clients.delete(idle[0]);
    }
    client = new SembleClient(root);
    clients.set(root, client);
  }
  return client.request(tool, args);
}

/** Server shutdown: stop every Semble process. */
export function shutdownSembleClients(): void {
  for (const client of clients.values()) client.dispose();
  clients.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

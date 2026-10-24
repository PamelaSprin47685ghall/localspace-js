// Full /mcp request+response log: one JSONL file per UTC hour under <stateDir>/traffic, files older than the previous hour are deleted.
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RequestHandler } from "express";
import { trackInflight } from "./inflight.js";

const HOUR = 3_600_000;
const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, "");

const SECRET_HEADERS = new Set(["authorization", "cookie"]);
const redact = (headers: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), SECRET_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v]));

const parse = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return text; }
};

function rpcInfo(body: unknown): { tool?: string; workspaceId?: string } {
  if (!body || typeof body !== "object") return {};
  const params = (body as Record<string, unknown>).params;
  if (!params || typeof params !== "object") return {};
  const record = params as Record<string, unknown>;
  const tool = typeof record.name === "string" ? record.name : undefined;
  const args = record.arguments && typeof record.arguments === "object" ? (record.arguments as Record<string, unknown>) : undefined;
  const workspaceId = typeof args?.workspaceId === "string" ? args.workspaceId : undefined;
  return { tool, workspaceId };
}

export function trafficLog(stateDir: string, enabled = true): RequestHandler {
  const dir = join(stateDir, "traffic");
  let hour = "";
  const ready = mkdir(dir, { recursive: true, mode: 0o700 });

  const prune = async (now: number) => {
    const keep = new Set([hourOf(now), hourOf(now - HOUR)]);
    for (const f of await readdir(dir)) if (f.endsWith(".jsonl") && !keep.has(f.slice(0, -6))) await unlink(join(dir, f)).catch(() => undefined);
  };

  const append = async (entry: object) => {
    await ready;
    const now = Date.now();
    const h = hourOf(now);
    if (h !== hour) { hour = h; void prune(now).catch(() => undefined); }
    await appendFile(join(dir, `${h}.jsonl`), JSON.stringify(entry) + "\n", { mode: 0o600 });
  };

  return (req, res, next) => {
    if (!enabled) return next();
    const t0 = Date.now();
    const requestId = String(res.locals.requestId ?? "");
    const info = rpcInfo(req.body);
    // A start record without an end record is a request that is still (or was) hung.
    void append({ phase: "start", ts: new Date(t0).toISOString(), requestId, method: req.method, ...info }).catch(() => undefined);
    const release = trackInflight({ requestId, method: req.method, ...info });
    // A request that is still open after 10s is what clients experience as "hung"; say so now
    // instead of waiting for it to close.
    const slow = setTimeout(() => {
      void append({ phase: "slow", ts: new Date(t0).toISOString(), requestId, method: req.method, ...info, elapsedMs: Date.now() - t0 }).catch(() => undefined);
    }, 10_000);
    slow.unref();
    const chunks: Buffer[] = [];
    const grab = (c: unknown, enc?: unknown) => {
      if (c == null || typeof c === "function") return;
      chunks.push(ArrayBuffer.isView(c) ? Buffer.from(c.buffer, c.byteOffset, c.byteLength) : Buffer.from(String(c), typeof enc === "string" ? (enc as BufferEncoding) : "utf8"));
    };
    const { write, end } = res;
    res.write = function (this: typeof res, c: unknown, ...rest: unknown[]) { grab(c, rest[0]); return (write as Function).call(this, c, ...rest); } as typeof res.write;
    res.end = function (this: typeof res, c?: unknown, ...rest: unknown[]) { grab(c, rest[0]); return (end as Function).call(this, c, ...rest); } as typeof res.end;
    res.once("close", () => {
      clearTimeout(slow);
      release();
      void append({
        phase: "end",
        ts: new Date(t0).toISOString(),
        requestId: res.locals.requestId,
        method: req.method,
        status: res.statusCode,
        finished: res.writableFinished,
        durationMs: Date.now() - t0,
        ip: req.ip,
        userAgent: req.header("user-agent"),
        protocolVersion: req.header("mcp-protocol-version"),
        headers: redact(req.headers),
        request: req.body,
        response: parse(Buffer.concat(chunks).toString("utf8")),
      }).catch(() => undefined);
    });
    next();
  };
}

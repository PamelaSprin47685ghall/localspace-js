#!/usr/bin/env node
// tail -f for LocalSpace activity: one line per /mcp request, from the traffic logs.
// Usage: npm run monitor [-- --state-dir DIR] [--full] [--no-color]
import { readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const stateDir = option("--state-dir", join(homedir(), ".local", "share", "localspace"));
const trafficDir = join(stateDir, "traffic");
const full = flag("--full");
const color = !flag("--no-color") && !process.env.NO_COLOR && process.stdout.isTTY === true;

const paint = (code) => (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = paint("2");
const bold = paint("1");
const cyan = paint("36");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const magenta = paint("35");
const blue = paint("34");

const CLIENT_COLORS = { Codex: cyan, ChatGPT: green, Grok: magenta, Mistral: blue };

function clientOf(userAgent) {
  const ua = String(userAgent ?? "");
  if (/Codex/i.test(ua)) return "Codex";
  if (/Mistral/i.test(ua)) return "Mistral";
  if (/grok/i.test(ua)) return "Grok";
  if (/openai-mcp/i.test(ua)) return "ChatGPT";
  if (/curl/i.test(ua)) return "curl";
  if (!ua) return "unknown";
  return ua.replace(/\/.*$/, "").slice(0, 12);
}

const roots = new Map(); // workspaceId -> root

function workspaceLabel(record) {
  const args = record.request?.params?.arguments;
  const opened = record.response?.result?.structuredContent;
  if (opened?.root && typeof opened.root === "string") return opened.root.split("/").filter(Boolean).pop() ?? opened.root;
  const id =
    (typeof args?.workspaceId === "string" ? args.workspaceId : undefined) ??
    (typeof record.workspaceId === "string" ? record.workspaceId : undefined);
  if (!id) return "latest";
  if (id.includes("/")) return id.split("/").filter(Boolean).pop();
  const root = roots.get(id);
  if (root) return root.split("/").filter(Boolean).pop();
  return id;
}

const oneLine = (text, limit) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

function clock(ts) {
  const d = ts ? new Date(ts) : new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function seconds(ms) {
  if (ms === undefined || ms === null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function intentOf(record) {
  const fromStart = typeof record.intent === "string" ? record.intent : "";
  const fromRequest = record.request?.params?.arguments?.intent;
  const text = fromStart || (typeof fromRequest === "string" ? fromRequest : "");
  return text ? oneLine(text, full ? 200 : 70) : "";
}

function programOf(args) {
  const program = args?.program;
  if (typeof program !== "string") return "";
  return oneLine(program, full ? 400 : 110);
}

function outcomeOf(response) {
  const structured = response?.result?.structuredContent;
  if (!structured) {
    const error = response?.error;
    if (error) return `error ${error.code ?? ""} ${oneLine(error.message, 60)}`.trim();
    return "";
  }
  const parts = [structured.status];
  if (structured.parked?.kind) parts.push(`parked:${structured.parked.kind}`);
  if (structured.error?.code) parts.push(structured.error.code);
  if (structured.written?.length) parts.push(`+${structured.written.length} written`);
  if (structured.value !== undefined) parts.push(oneLine(JSON.stringify(structured.value), 80));
  return parts.filter(Boolean).join(" ");
}

function toolOf(record) {
  return (
    record.tool ??
    record.request?.params?.name ??
    record.rpcMethod ??
    record.request?.method ??
    record.method ??
    "?"
  );
}

function emit(record) {
  const time = dim(clock(record.ts));
  const clientName = clientOf(record.userAgent ?? record.headers?.["user-agent"]);
  const client = (CLIENT_COLORS[clientName] ?? paint("37"))(clientName.padEnd(8));
  const args = record.request?.params?.arguments;
  const tool = toolOf(record).padEnd(14);
  const space = bold(workspaceLabel(record).padEnd(16));

  if (record.phase === "start") {
    const hint = oneLine(args?.path ?? "", 60) || intentOf(record);
    process.stdout.write(`${time} ${dim("▶")} ${client} ${tool} ${space} ${dim(hint)}\n`);
    return;
  }
  if (record.phase === "slow") {
    const note = yellow(`still open after ${seconds(record.elapsedMs)}`);
    process.stdout.write(`${time} ${yellow("…")} ${client} ${tool} ${space} ${note}\n`);
    return;
  }
  if (record.phase !== "end") return;

  const httpOk = record.status >= 200 && record.status < 300;
  const resultOk = httpOk && !record.response?.result?.isError;
  const mark = resultOk ? green("✓") : red("✗");
  const took = record.finished === false ? red("client gone") : dim(seconds(record.durationMs));
  const detail = httpOk ? outcomeOf(record.response) : `HTTP ${record.status}`;
  const program = programOf(args);
  const intent = intentOf(record);
  process.stdout.write(`${time} ${mark} ${client} ${tool} ${space} ${took.padEnd(12)} ${detail}\n`);
  if (intent) process.stdout.write(`${dim(" ".repeat(8) + "→ " + intent)}\n`);
  if (program) process.stdout.write(`${dim(" ".repeat(8) + "│ " + program)}\n`);
}

// Follow every hourly file, including new ones after rotation.
const offsets = new Map();
const buffers = new Map();

function tail() {
  let names;
  try {
    names = readdirSync(trafficDir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(trafficDir, name);
    let size;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    const offset = offsets.get(path) ?? 0;
    if (size <= offset) continue;
    const fd = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(size - offset);
      readSync(fd, chunk, 0, chunk.length, offset);
      offsets.set(path, size);
      const text = (buffers.get(path) ?? "") + chunk.toString("utf8");
      const lines = text.split("\n");
      buffers.set(path, lines.pop() ?? "");
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.response?.result?.structuredContent?.workspaceId && record.response.result.structuredContent.root) {
          roots.set(record.response.result.structuredContent.workspaceId, record.response.result.structuredContent.root);
        }
        emit(record);
      }
    } finally {
      closeSync(fd);
    }
  }
}

process.stdout.write(
  `${bold("LocalSpace monitor")} ${dim(trafficDir)} ${dim("(Ctrl-C 退出)")}\n` +
    `${dim("time     mark client   tool           workspace        took         outcome")}\n`,
);
// Start at the end of existing files: only show what happens next.
for (const name of readdirSync(trafficDir).filter((n) => n.endsWith(".jsonl"))) {
  try {
    offsets.set(join(trafficDir, name), statSync(join(trafficDir, name)).size);
  } catch {
    // file vanished between list and stat
  }
}
setInterval(tail, 200);
tail();
process.on("SIGINT", () => process.exit(0));

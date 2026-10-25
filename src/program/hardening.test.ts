import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParkTable } from "./park.js";
import { RequestWindow } from "./request-window.js";
import { liveProgramCount, runProgram, shutdownPrograms } from "./runner.js";
import { STREAM_CAP, TailBuffer } from "./call.js";
import { CAT_MAX_BYTES } from "./api.js";
import { startEventLoopMonitor } from "../event-loop-monitor.js";

const root = mkdtempSync(join(tmpdir(), "localspace-hard-"));
const configDir = join(root, ".localspace");
const stateDir = join(root, "state");
mkdirSync(configDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitGone(pgid: number, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until && groupAlive(pgid)) await sleep(50);
  return !groupAlive(pgid);
}

function run(program: string, opts: { budget?: number; parkTable?: ParkTable; signal?: AbortSignal; workspaceId?: string } = {}) {
  return runProgram({
    workspaceId: opts.workspaceId ?? "ws_hard",
    root,
    allowedRoots: [root],
    configDir,
    stateDir,
    program,
    intent: 'w'.repeat(Math.ceil((opts.budget ?? 30_000) / 50)),
    parkTable: opts.parkTable ?? new ParkTable(60_000),
    signal: opts.signal,
  });
}

// while(true){} parks at budget, never blocks the main loop or other programs, and abandon kills it.
{
  const table = new ParkTable(60_000);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 20);
  const started = Date.now();
  const busy = run("while (true) {}", { budget: 500, parkTable: table });
  const otherStarted = Date.now();
  const other = await run("return 41 + 1");
  const otherMs = Date.now() - otherStarted;
  const parked = await busy;
  clearInterval(ticker);
  assert.equal(other.status, "done");
  assert.equal(other.value, 42);
  assert.ok(otherMs < 3000, `other program took ${otherMs}ms`);
  assert.equal(parked.status, "parked");
  assert.equal(parked.parked?.kind, "yield");
  assert.ok(Date.now() - started < 3000);
  assert.ok(ticks >= 10, `main loop ticked only ${ticks} times`);
  // resuming a still-busy program yields again at the next budget instead of hanging
  const busySite = table.take(parked.parked!.handle);
  assert.equal(busySite.status, "ok");
  if (busySite.status !== "ok") throw new Error("missing busy site");
  const again = await busySite.site.resume(undefined, new RequestWindow("w".repeat(20)));
  assert.equal(again.parked?.kind, "yield");
  const againSite = table.take(again.parked!.handle);
  assert.equal(againSite.status, "ok");
  if (againSite.status !== "ok") throw new Error("missing resumed site");
  await againSite.site.abandon();
  await sleep(100);
  assert.equal(liveProgramCount(), 0);
  console.log("while(true) isolated + abandon: ok");
}

// A never-resolving promise yields too.
{
  const r = await run("await new Promise(() => {})", { budget: 300 });
  assert.equal(r.parked?.kind, "yield");
  shutdownPrograms();
  console.log("never-resolving promise yields: ok");
}

// Foreground call whose grandchild keeps the pipe open returns promptly; the leftover is killed.
{
  const r = await run(`const x = await this.call("(sleep 300 &); echo hi"); return { out: x.stdout, pid: x.pid, ms: x.durationMs };`);
  assert.equal(r.status, "done", JSON.stringify(r));
  const v = r.value as { out: string; pid: number; ms: number };
  assert.match(v.out, /hi/);
  assert.ok(v.ms < 2000, `foreground took ${v.ms}ms`);
  assert.ok(await waitGone(v.pid), "foreground leftover survived");
  console.log("foreground leftover reaped: ok");
}

// Output cap: only the tail is kept, dropped bytes are reported.
{
  const r = await run(
    `const x = await this.call("head -c 5000000 /dev/zero | tr '\\\\0' a; echo END"); return { len: x.stdout.length, t: x.truncated, dropped: x.truncatedBytes.stdout, total: x.bytes.stdout, end: x.stdout.trimEnd().endsWith("END") };`,
  );
  assert.equal(r.status, "done", JSON.stringify(r));
  const v = r.value as { len: number; t: boolean; dropped: number; total: number; end: boolean };
  assert.equal(v.t, true);
  assert.equal(v.total, 5_000_004);
  assert.equal(v.dropped, 5_000_004 - STREAM_CAP);
  assert.ok(v.len < STREAM_CAP + 200);
  assert.ok(v.end);
  const tb = new TailBuffer(4);
  tb.push(Buffer.from("ab"));
  tb.push(Buffer.from("cdef"));
  assert.equal(tb.dropped, 2);
  assert.match(tb.toString(), /cdef$/);
  console.log("output tail cap: ok");
}

// cat refuses huge files; oversized return values are refused.
{
  writeFileSync(join(root, "big.txt"), Buffer.alloc(CAT_MAX_BYTES + 1, 97));
  const r = await run(`return (await this.cat("big.txt")).length`);
  assert.equal(r.error?.code, "FILE_TOO_LARGE");
  const big = await run(`return "x".repeat(2_000_000)`);
  assert.equal(big.error?.code, "RESULT_TOO_LARGE");
  console.log("cat / result size guards: ok");
}

// Park TTL expiry abandons the program and kills its groups without anyone touching the table.
{
  const table = new ParkTable(300);
  const r = await run(
    `await this.park({ note: "ttl" });`,
    { parkTable: table },
  );
  assert.equal(r.parked?.kind, "park");
  await sleep(400);
  assert.equal(table.size, 0);
  console.log("park TTL sweep cleans table: ok");
}

// Client disconnect (AbortSignal) keeps the program alive and leaves a claimable park.
{
  const table = new ParkTable(60_000);
  const ac = new AbortController();
  const pending = run(`const out = await this.call("sleep 1.2; echo KEPT"); return out.stdout.trim();`, {
    signal: ac.signal,
    parkTable: table,
  });
  await sleep(150);
  ac.abort();
  const gone = await pending;
  assert.equal(gone.status, "parked", JSON.stringify(gone));
  const handle = gone.parked!.handle;
  assert.equal(table.list("ws_hard").length, 1, "disconnect must leave a claimable site");
  await sleep(1300);
  const taken = table.take(handle, "ws_hard");
  assert.equal(taken.status, "ok");
  const resumed = await (taken as { site: { resume: (v: unknown, w: unknown) => Promise<{ status: string; value?: unknown }> } }).site.resume(
    undefined,
    new RequestWindow("w".repeat(400)),
  );
  assert.equal(resumed.status, "done", JSON.stringify(resumed));
  assert.equal(resumed.value, "KEPT");
  console.log("client disconnect keeps the program alive: ok");
}

// intent is capped at 30s no matter how long it is written.
{
  assert.equal(new RequestWindow("b".repeat(200)).budgetMs, 10_000);
  const long = new RequestWindow("b".repeat(2_000));
  assert.equal(long.requestedMs, 100_000);
  assert.equal(long.budgetMs, 30_000);
  assert.equal(long.capped, true);
  console.log("request window is capped at 30s: ok");
}

// Event-loop lag monitor warns when the main thread stalls.
{
  const lags: number[] = [];
  const mon = startEventLoopMonitor({ intervalMs: 100, warnMs: 100, onLag: (l) => lags.push(l.maxMs) });
  await sleep(50);
  const until = Date.now() + 300;
  while (Date.now() < until) {
    /* stall main thread */
  }
  await sleep(250);
  mon.stop();
  assert.ok(lags.some((ms) => ms >= 200), `lags: ${lags}`);
  console.log("event-loop lag monitor: ok");
}

assert.equal(liveProgramCount(), 0);
console.log("hardening.test.ts: all ok");

// A call that outlives its intent keeps running: unpark delivers the real CallResult (not the
// park argument), and output produced before the yield is still in the final result.
{
  const table = new ParkTable(60_000);
  const first = await run(
    `return await this.call("echo EARLY; sleep 0.6; echo LATE");`,
    { budget: 400, parkTable: table },
  );
  assert.equal(first.parked?.kind, "yield");
  const payload = first.parked!.payload as { delta?: { stdout: string } };
  assert.match(payload.delta?.stdout ?? "", /EARLY/);
  await sleep(900);
  const resumed = await run(
    `return await this.unpark(${JSON.stringify(first.parked!.handle)}, { intent: "not a CallResult" });`,
    { budget: 5000, parkTable: table },
  );
  assert.equal(resumed.status, "done", JSON.stringify(resumed));
  const v = resumed.value as { exitCode: number; stdout: string; intent?: string };
  assert.equal(v.exitCode, 0);
  assert.match(v.stdout, /EARLY/);
  assert.match(v.stdout, /LATE/);
  assert.equal(v.intent, undefined);
  console.log("yield keeps call alive + real result: ok");
}

// Parallel calls keep their own output (one parked proc must not clobber another).
{
  const r = await run(
    `const [a, b] = await Promise.all([
      this.call("sleep 0.3; echo A"),
      this.call("sleep 0.3; echo B"),
    ]);
    return { a: a.stdout.trim(), b: b.stdout.trim() };`,
    { budget: 10_000 },
  );
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.deepEqual(r.value, { a: "A", b: "B" });
  console.log("parallel calls keep separate output: ok");
}

// Shared entry deadline never disappears while waiting for a command.
{
  const table = new ParkTable(60_000);
  const first = await run('return await this.call("sleep 30");', { budget: 400, parkTable: table });
  assert.equal(first.parked?.kind, "yield");
  const startedAt = Date.now();
  const again = await run(`return await this.unpark(${JSON.stringify(first.parked!.handle)});`, { budget: 1000, parkTable: table });
  assert.equal(again.parked?.kind, "yield", JSON.stringify(again));
  assert.ok(Date.now() - startedAt < 3000);
  const abandoned = await run(`return await this.abandon(${JSON.stringify(again.parked!.handle)});`, { parkTable: table });
  assert.equal(abandoned.status, "done", JSON.stringify(abandoned));
  assert.equal(table.size, 0);
  console.log("shared deadline bounds unpark of a stuck command: ok");
}

// A handle from another workspace is rejected without being consumed.
{
  const table = new ParkTable(60_000);
  const first = await run(`return await this.call("sleep 30");`, { budget: 400, parkTable: table, workspaceId: "ws_a" });
  const handle = first.parked!.handle;
  const stray = await run(`return await this.unpark(${JSON.stringify(handle)});`, { budget: 60_000, parkTable: table, workspaceId: "ws_b" });
  assert.equal(stray.status, "failed", JSON.stringify(stray));
  assert.equal(stray.error?.code, "PARK_NOT_FOUND");
  assert.ok(!/其他|另一个|别的工作区|other/i.test(stray.error?.message ?? ""), stray.error?.message);
  assert.equal(table.list("ws_a").length, 1, "the mismatched unpark consumed the site");
  const own = await run(`return await this.abandon(${JSON.stringify(handle)});`, { budget: 60_000, parkTable: table, workspaceId: "ws_a" });
  assert.equal(own.status, "done", JSON.stringify(own));
  assert.equal(table.size, 0);
  console.log("park handles are workspace-scoped: ok");
}

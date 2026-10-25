import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { ParkTable } from "./park.js";
import { liveProgramCount, runProgram, shutdownPrograms, type RunProgramInput, type RunProgramResult } from "./runner.js";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const literal = (value: unknown) => JSON.stringify(value) ?? "undefined";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = (source: string) => quote(process.execPath) + " -e " + quote(source);
// Host fixture data, never computed inside a model program.
const intent = (ms: number) => "b".repeat(Math.ceil(ms / 50));
const resume = (handle: string, value?: unknown) => "return await this.unpark(" + literal(handle) + "," + literal(value) + ");";
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const end = performance.now() + 8000;
  while (!await predicate()) {
    if (performance.now() >= end) throw new Error("Timed out: " + label);
    await delay(25);
  }
}
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out: " + label)), Math.max(1, ms));
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function parked(result: RunProgramResult): string {
  assert.equal(result.status, "parked", JSON.stringify(result));
  assert.ok(result.parked?.handle, JSON.stringify(result));
  return result.parked.handle;
}
function done(result: RunProgramResult): unknown {
  assert.equal(result.status, "done", JSON.stringify(result));
  return result.value;
}
function invalid(result: RunProgramResult) {
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.error?.code, "INVALID_ARGUMENT", JSON.stringify(result));
}
interface Barrier { command: string; ready: string; release: string; finished: string; starts: string; token: string }
class Fixture {
  readonly table = new ParkTable(120000);
  readonly workspaceId: string;
  private readonly barriers: Barrier[] = [];
  constructor(readonly root: string) { this.workspaceId = "budget-" + basename(root); }
  file(name: string) { return join(this.root, name); }
  input(program: string, budget: string): RunProgramInput {
    return { workspaceId: this.workspaceId, root: this.root, allowedRoots: [this.root],
      configDir: this.file("config"), stateDir: this.file("state"), program, intent: budget, parkTable: this.table };
  }
  start(program: string, ms = 8000) {
    const at = performance.now();
    return { at, ms, result: runProgram(this.input(program, intent(ms))) };
  }
  run(program: string, ms = 8000) { return within(this.start(program, ms).result, ms + 4000, "program"); }
  deadline(run: ReturnType<Fixture["start"]>) {
    return within(run.result, run.at + run.ms + 1250 - performance.now(), "shared deadline");
  }
  barrier(label: string): Barrier {
    const b = { command: "", ready: this.file(label + ".ready"), release: this.file(label + ".release"),
      finished: this.file(label + ".done"), starts: this.file(label + ".starts"), token: "finished:" + label };
    b.command = command("const fs=require('node:fs');fs.appendFileSync(" + literal(b.starts) + ",'started\\n');" +
      "fs.writeFileSync(" + literal(b.ready) + ",'ready');function poll(){if(!fs.existsSync(" + literal(b.release) +
      ")){setTimeout(poll,25);return;}fs.writeFileSync(" + literal(b.finished) + ",'done');process.stdout.write(" +
      literal(b.token + "\n") + ");}poll();");
    this.barriers.push(b);
    return b;
  }
  ready(b: Barrier) { return until(() => exists(b.ready), "command admission"); }
  release(b: Barrier) { return writeFile(b.release, "release"); }
  finished(b: Barrier) { return until(() => exists(b.finished), "command completion"); }
  async starts(b: Barrier) { return (await readFile(b.starts, "utf8")).split("\n").filter(Boolean).length; }
  async cleanup() {
    await Promise.all(this.barriers.map(b => writeFile(b.release, "cleanup").catch(() => undefined)));
    this.table.clear(); shutdownPrograms(); await delay(150);
    await rm(this.root, { recursive: true, force: true });
  }
}
let passed = 0;
async function check(name: string, body: (fixture: Fixture) => Promise<void>) {
  const h = new Fixture(await mkdtemp(join(tmpdir(), "localspace-budget-")));
  await Promise.all([mkdir(h.file("config")), mkdir(h.file("state"))]);
  try { await body(h); console.log("ok " + (++passed) + " - " + name); }
  finally { await h.cleanup(); }
}

await check("top-level intent validates before worker or effects; whitespace is accepted", async h => {
  const program = "await this.write('invalid-effect','unexpected'); return 1;";
  const baseline = liveProgramCount();
  const missing = h.input(program, "placeholder");
  delete (missing as Partial<RunProgramInput>).intent;
  invalid(await runProgram(missing));
  for (const value of [null, "", 0, false, {}]) invalid(await runProgram(h.input(program, value as string)));
  assert.equal(await exists(h.file("invalid-effect")), false);
  assert.equal(liveProgramCount(), baseline);
  const accepted = await runProgram(h.input("return {accepted:true};", " "));
  assert.notEqual(accepted.status, "failed", JSON.stringify(accepted));
  assert.deepEqual(done(accepted.status === "parked" ? await h.run(resume(parked(accepted))) : accepted), {accepted:true});
});

await check("repeat(48000) cannot provide call or unpark member budgets", async h => {
  const effect = h.file("member-effect");
  const cmd = command("require('node:fs').writeFileSync(" + literal(effect) + ",'unexpected');");
  invalid(await h.run("const intent='x'.repeat(48000); return await this.call(" + literal(cmd) + ",intent);"));
  assert.equal(await exists(effect), false);
  const target = parked(await h.run("const value=await this.park({stage:'ready'});await this.write('resumed',String(value));return value;"));
  invalid(await h.run("const intent='x'.repeat(48000);return await this.unpark(" + literal(target) + ",undefined,intent);"));
  assert.equal(await exists(h.file("resumed")), false);
  assert.ok(h.table.list(h.workspaceId).some(site => site.handle === target));
  assert.equal(done(await h.run(resume(target, "accepted"))), "accepted");
});

await check("sequential real calls share one cumulative deadline", async h => {
  const a = h.barrier("first"), b = h.barrier("second");
  const run = h.start("const a=await this.call(" + literal(a.command) + ");const b=await this.call(" +
    literal(b.command) + ");return {first:a.stdout,second:b.stdout};", 4000);
  await h.ready(a); await delay(Math.max(0, run.at + 2500 - performance.now())); await h.release(a); await h.ready(b);
  const handle = parked(await h.deadline(run));
  assert.equal(await exists(b.finished), false);
  await h.release(b); await h.finished(b);
  assert.deepEqual(done(await h.run(resume(handle))), {first:a.token+"\n",second:b.token+"\n"});
  assert.equal(await h.starts(a),1); assert.equal(await h.starts(b),1);
});

await check("unpark borrows only the controller's remaining time", async h => {
  const spend=h.barrier("spend"), call=h.barrier("target");
  const target=parked(await h.run("const value=await this.park({stage:'ready'});const r=await this.call(" +
    literal(call.command) + ");return {value,stdout:r.stdout,exitCode:r.exitCode};"));
  const run=h.start("await this.call(" + literal(spend.command) + ");" + resume(target,"once"),4000);
  await h.ready(spend);await delay(Math.max(0,run.at+2500-performance.now()));await h.release(spend);await h.ready(call);
  const next=parked(await h.deadline(run));assert.notEqual(next,target);
  assert.equal(await exists(call.finished),false);
  await h.release(call);await h.finished(call);
  assert.deepEqual(done(await h.run(resume(next))),{value:"once",stdout:call.token+"\n",exitCode:0});
  assert.equal(await h.starts(call),1);
});

await check("nested unpark propagates the real leaf continuation", async h => {
  const b=h.barrier("leaf");
  const leaf=parked(await h.run("await this.park({stage:'leaf'});const r=await this.call(" +
    literal(b.command) + ");return {leaf:true,stdout:r.stdout};"));
  const middle=parked(await h.run("const h=await this.park({stage:'middle'});return await this.unpark(h);"));
  const run=h.start(resume(middle,leaf),3000);await h.ready(b);
  const next=parked(await h.deadline(run));
  assert.notEqual(next,leaf);assert.notEqual(next,middle);
  assert.deepEqual(h.table.list(h.workspaceId).map(site=>site.handle),[next]);
  await h.release(b);await h.finished(b);
  assert.deepEqual(done(await h.run(resume(next))),{leaf:true,stdout:b.token+"\n"});
  assert.equal(await h.starts(b),1);assert.deepEqual(h.table.list(h.workspaceId),[]);
});

await check("a call requested after expiry waits for explicit resume", async h => {
  const b=h.barrier("late");
  const run=h.start("await new Promise(r=>setTimeout(r,1500));await this.write('attempted','yes');" +
    "const r=await this.call(" + literal(b.command) + ");return r.exitCode;",500);
  const handle=parked(await h.deadline(run));
  await until(()=>exists(h.file("attempted")),"worker reaches call");await delay(500);
  assert.equal(await exists(b.ready),false);
  const next=h.start(resume(handle));await h.ready(b);await h.release(b);
  assert.equal(done(await within(next.result,8000,"resumed late call")),0);assert.equal(await h.starts(b),1);
});

await check("completion after expiry stays cached until resume without rerunning", async h => {
  const b=h.barrier("cache");
  const run=h.start("const r=await this.call(" + literal(b.command) +
    ");await this.write('after-call','continued');return {stdout:r.stdout,exitCode:r.exitCode};",2000);
  await h.ready(b);const handle=parked(await h.deadline(run));
  await h.release(b);await h.finished(b);await delay(500);
  assert.equal(await exists(h.file("after-call")),false);
  await rm(b.release);
  const final=await within(h.run(resume(handle)),4000,"cached result");
  assert.deepEqual(done(final),{stdout:b.token+"\n",exitCode:0});
  assert.equal(await readFile(h.file("after-call"),"utf8"),"continued");assert.equal(await h.starts(b),1);
});

await check("unpark after expiry cannot consume or resume its target", async h => {
  const target=parked(await h.run("const v=await this.park({stage:'target'});await this.write('target-effect',String(v));return v;"));
  const run=h.start("await new Promise(r=>setTimeout(r,1500));await this.write('attempted','yes');"+resume(target,"once"),500);
  const controller=parked(await h.deadline(run));await until(()=>exists(h.file("attempted")),"worker reaches unpark");await delay(500);
  assert.equal(await exists(h.file("target-effect")),false);
  assert.ok(h.table.list(h.workspaceId).some(site=>site.handle===target));
  assert.equal(done(await h.run(resume(controller))),"once");
  assert.equal(await readFile(h.file("target-effect"),"utf8"),"once");assert.deepEqual(h.table.list(h.workspaceId),[]);
});
assert.equal(liveProgramCount(),0);
console.log("All "+passed+" program budget checks passed.");

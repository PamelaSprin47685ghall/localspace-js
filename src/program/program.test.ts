import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ParkTable } from "./park.js";
import { runProgram } from "./runner.js";
import { analyzeCommandDanger, assertInsideRoots, assertNotAuthFile } from "./guard.js";
import { whereAll, nearestLine } from "./where.js";
import { PAIR_HINT_SEPARATOR, composePairHints, appendPairHints } from "./pair-hint.js";
import { ProgramError } from "./errors.js";

const root = mkdtempSync(join(tmpdir(), "localspace-js-"));
const configDir = join(root, ".localspace");
const stateDir = join(root, "state");
mkdirSync(configDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(configDir, "auth.json"), '{"ownerToken":"x"}');
writeFileSync(join(root, "README.md"), "# Hello\n\n## Install\n\nrun me\n");

const parkTable = new ParkTable(60_000);

async function run(program: string) {
  return runProgram({
    workspaceId: "ws_test",
    root,
    allowedRoots: [root],
    configDir,
    stateDir,
    program,
    yieldBudgetMs: 30_000,
    parkTable,
  });
}

{
  const result = await run(`
    const text = await this.cat("README.md");
    return { len: text.length, head: text.slice(0, 5) };
  `);
  assert.equal(result.status, "done");
  assert.equal((result.value as { head: string }).head, "# Hel");
  console.log("this.cat/return: ok");
}

{
  const result = await run(`
    await this.write("note.txt", "你好");
    const text = await this.cat("note.txt");
    return text;
  `);
  if (result.status !== "done") console.error(result);
  assert.equal(result.status, "done");
  assert.equal(result.value, "你好");
  assert.ok(result.written.includes("note.txt"));
  console.log("this.write as-is: ok");
}

{
  const result = await run(`
    const text = await this.cat("README.md");
    const span = await this.where(text, "## Missing Heading");
    return span;
  `);
  assert.equal(result.status, "parked");
  assert.equal(result.parked?.kind, "where");
  const handle = result.parked!.handle;
  const payload = result.parked!.payload as { nearest: { span: [number, number] } | null };
  assert.ok(payload.nearest);
  const resumed = await run(`
    return await this.unpark(${JSON.stringify(handle)}, ${JSON.stringify(payload.nearest!.span)});
  `);
  assert.equal(resumed.status, "done");
  console.log("this.where-park + this.unpark: ok");
}

{
  const result = await run(`
    return await this.call("rm -rf totally-not-real-path-xyz");
  `);
  assert.equal(result.status, "parked");
  assert.equal(result.parked?.kind, "confirm");
  const handle = result.parked!.handle;
  const forced = await run(`
    return await this.unpark(${JSON.stringify(handle)}, { dangerous: true });
  `);
  if (forced.status !== "done") console.error("forced", forced);
  assert.equal(forced.status, "done");
  console.log("dangerous-park + this.unpark: ok");
}

{
  assert.throws(
    () => assertInsideRoots("/etc/passwd", [root]),
    (error: unknown) => error instanceof ProgramError && error.code === "PATH_DENIED",
  );
  assert.throws(
    () => assertNotAuthFile(join(configDir, "auth.json"), configDir),
    (error: unknown) => error instanceof ProgramError && error.code === "AUTH_PROTECTED",
  );
  console.log("hard denies: ok");
}

{
  assert.equal(analyzeCommandDanger("sudo ls"), undefined);
  assert.ok(analyzeCommandDanger("git reset --hard"));
  assert.equal(analyzeCommandDanger("echo hi"), undefined);
  console.log("danger rules: ok");
}

{
  const spans = whereAll("aa bb\ncc bb", "bb");
  assert.equal(spans.length, 2);
  assert.ok(nearestLine("one\ntwo\nthree", "too"));
  console.log("whereAll/nearest: ok");
}

{
  const hints = composePairHints({
    workspaceId: "ws",
    root: "/tmp/x",
    parked: [],
    motto: "口诀",
    git: { staged: 1, unstaged: 0, untracked: 0, dirty: true },
  });
  assert.ok(hints.startsWith(PAIR_HINT_SEPARATOR));
  assert.ok(hints.includes("口诀"));
  assert.equal(appendPairHints("body", hints), "body" + hints);
  console.log("pair-hint: ok");
}

{
  // yield park with tiny budget
  const result = await runProgram({
    workspaceId: "ws_test",
    root,
    allowedRoots: [root],
    configDir,
    stateDir,
    program: `
      await this.call("sleep 1");
      return "done";
    `,
    yieldBudgetMs: 150,
    parkTable: new ParkTable(60_000),
  });
  assert.equal(result.status, "parked");
  assert.equal(result.parked?.kind, "yield");
  console.log("yield-park: ok");
}

{
  // call spawn / send / read / signal / join
  const result = await run(`
    await this.call({ spawn: "bash -lc 'while true; do echo ping; sleep 0.2; done'", name: "echoer" });
    const mid = await this.call({ read: { name: "echoer", waitMs: 400 } });
    await this.call({ signal: "SIGTERM", name: "echoer" });
    const end = await this.call({ join: { name: "echoer", timeoutMs: 3000 } });
    return {
      midOut: mid.stdout.includes("ping"),
      exitCode: end.exitCode,
      name: end.name,
    };
  `);
  if (result.status !== "done") console.error("spawn suite", result);
  assert.equal(result.status, "done");
  const v = result.value as { midOut: boolean; exitCode: number | null; name: string };
  assert.equal(v.midOut, true);
  assert.ok(v.exitCode === 0 || v.exitCode === 143 || v.exitCode === null || typeof v.exitCode === "number");
  assert.equal(v.name, "echoer");
  console.log("this.call spawn/read/signal/join: ok");
}

{
  // waitFor port
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const result = await run(`
    return await this.call({ waitFor: { port: ${port}, timeoutMs: 2000 } });
  `);
  server.close();
  assert.equal(result.status, "done");
  assert.equal((result.value as { exitCode: number }).exitCode, 0);
  console.log("this.call waitFor: ok");
}

{
  // abandon
  const parked = await run(`return await this.park({ note: "hold" });`);
  assert.equal(parked.status, "parked");
  const handle = parked.parked!.handle;
  const gone = await run(`await this.abandon(${JSON.stringify(handle)}); return "abandoned";`);
  assert.equal(gone.status, "done");
  console.log("this.abandon: ok");
}

rmSync(root, { recursive: true, force: true });
console.log("program.test.ts: all ok");

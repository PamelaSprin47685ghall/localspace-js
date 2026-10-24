// Built-in Semble search: MCP stdio handshake, repo binding, result parsing, error mapping.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProgram } from "./runner.js";
import { shutdownSembleClients } from "./semble.js";
import { ParkTable } from "./park.js";

const root = mkdtempSync(join(tmpdir(), "localspace-semble-"));
const fake = join(root, "fake-semble.mjs");
writeFileSync(
  fake,
  `let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    } else if (msg.method === "tools/call") {
      const args = msg.params.arguments;
      if (args.query === "boom") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "index build failed" }], isError: true } });
      } else {
        const payload = { tool: msg.params.name, repo: args.repo, query: args.query ?? null, file_path: args.file_path ?? null, top_k: args.top_k ?? null, max_snippet_lines: args.max_snippet_lines ?? null, results: [{ file_path: "src/a.ts", start_line: 1, end_line: 2, score: 0.9 }] };
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
      }
    }
  }
});
`,
);

process.env.LOCALSPACE_SEMBLE_CMD = JSON.stringify([process.execPath, fake]);

async function run(program: string, workspaceRoot = root) {
  return runProgram({
    workspaceId: "ws_semble",
    root: workspaceRoot,
    allowedRoots: [workspaceRoot],
    configDir: join(workspaceRoot, ".localspace"),
    stateDir: join(workspaceRoot, "state"),
    program,
    planB: 'w'.repeat(600),
    parkTable: new ParkTable(60_000),
  });
}

{
  const r = await run(`return await this.search("parse initialize", { topK: 2, maxSnippetLines: null });`);
  assert.equal(r.status, "done", JSON.stringify(r));
  const v = r.value as { tool: string; repo: string; query: string; top_k: number; max_snippet_lines: null };
  assert.equal(v.tool, "search");
  assert.equal(v.repo, root, "repo must be the workspace root, not caller supplied");
  assert.equal(v.query, "parse initialize");
  assert.equal(v.top_k, 2);
  assert.equal(v.max_snippet_lines, null);
  console.log("this.search -> semble search: ok");
}

{
  const r = await run(`return await this.findRelated("src/a.ts", 7);`);
  assert.equal(r.status, "done", JSON.stringify(r));
  const v = r.value as { tool: string; file_path: string; repo: string };
  assert.equal(v.tool, "find_related");
  assert.equal(v.file_path, "src/a.ts");
  assert.equal(v.repo, root);
  console.log("this.findRelated -> semble find_related: ok");
}

{
  const r = await run(`return await this.search("x", { topK: 0 });`);
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "INVALID_ARGUMENT");
  console.log("search option validation: ok");
}

{
  const r = await run(`return await this.search("boom");`);
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "SEMBLE_FAILED");
  assert.match(r.error?.message ?? "", /index build failed/);
  console.log("semble tool error surfaces: ok");
}

{
  const other = mkdtempSync(join(tmpdir(), "localspace-semble-missing-"));
  const previous = process.env.LOCALSPACE_SEMBLE_CMD;
  process.env.LOCALSPACE_SEMBLE_CMD = JSON.stringify([join(other, "no-such-uvx")]);
  const r = await run(`return await this.search("x");`, other);
  process.env.LOCALSPACE_SEMBLE_CMD = previous;
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "SEMBLE_UNAVAILABLE");
  assert.match(r.error?.message ?? "", /uv/);
  console.log("missing uvx reported clearly: ok");
}

shutdownSembleClients();
console.log("semble.test.ts: all ok");

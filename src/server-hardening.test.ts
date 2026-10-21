// Server-level: a busy-looping program must not block HTTP/MCP; large bodies are accepted.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { liveProgramCount } from "./program/runner.js";

const root = mkdtempSync(join(tmpdir(), "localspace-srv-"));
const configDir = join(root, ".localspace");
mkdirSync(configDir, { recursive: true });
mkdirSync(join(root, "proj"), { recursive: true });
writeFileSync(join(root, "proj", "a.txt"), "hello\n");

const config = loadConfig({
  HOME: root,
  LOCALSPACE_CONFIG_DIR: configDir,
  LOCALSPACE_STATE_DIR: join(root, "state"),
  LOCALSPACE_ALLOWED_ROOTS: root,
  LOCALSPACE_AUTH_MODE: "none", // test-only: local ephemeral server
  LOCALSPACE_OAUTH_OWNER_TOKEN: "test-only-owner-token",
  LOCALSPACE_MCP_TRANSPORT_MODE: "stateless",
  LOCALSPACE_HOST: "127.0.0.1",
  LOCALSPACE_PORT: "0",
  LOCALSPACE_LOG_REQUESTS: "false",
  LOCALSPACE_AUDIT_LOG: "false",
});
const server = createServer(config);
const http = server.app.listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

async function client() {
  const c = new Client({ name: "hardening-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return c;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const structured = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;

const a = await client();
const opened = await a.callTool({ name: "open_workspace", arguments: { path: join(root, "proj") } });
const workspaceId = structured(opened).workspaceId as string;
assert.ok(workspaceId, text(opened));

// while(true) in one tool call; healthz and another tool call stay fast.
const busyStarted = Date.now();
const busy = a.callTool({ name: "js", arguments: { workspaceId, program: "while (true) {}", planB: "x".repeat(30) } });
await new Promise((r) => setTimeout(r, 200));
const hz = Date.now();
const health = await (await fetch(`${base}/healthz`)).json();
assert.ok(Date.now() - hz < 500, "healthz blocked");
assert.equal(health.livePrograms, 1);
const b = await client();
const quickStarted = Date.now();
const quick = await b.callTool({ name: "js", arguments: { workspaceId, program: "return 6 * 7", planB: "x".repeat(100) } });
assert.ok(Date.now() - quickStarted < 1500, `second call took ${Date.now() - quickStarted}ms`);
assert.equal(structured(quick).value, 42);
const parked = structured(await busy);
assert.equal(parked.status, "parked");
assert.equal((parked.parked as { kind: string }).kind, "yield");
assert.ok(Date.now() - busyStarted < 4000);
const handle = (parked.parked as { handle: string }).handle;
const gone = await b.callTool({ name: "js", arguments: { workspaceId, program: `await this.abandon(${JSON.stringify(handle)}); return "ok"`, planB: "x".repeat(100) } });
assert.equal(structured(gone).value, "ok", text(gone));
await new Promise((r) => setTimeout(r, 100));
assert.equal(liveProgramCount(), 0);
console.log("while(true) does not block HTTP/MCP: ok");

// A program body over express's old 100kb default is accepted.
const bigProgram = `const s = ${JSON.stringify("x".repeat(300_000))}; return s.length;`;
const big = await b.callTool({ name: "js", arguments: { workspaceId, program: bigProgram, planB: "x".repeat(100) } });
assert.equal(structured(big).value, 300_000, text(big));
console.log("300KB request body accepted: ok");

await a.close();
await b.close();
await server.close();
http.closeAllConnections();
http.close();
console.log("server-hardening.test.ts: all ok");

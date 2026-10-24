// Server-level: both protocol eras, client-disconnect abort, busy programs never block HTTP/MCP, large bodies, bearer 401.
import assert from "node:assert/strict";
import { installProcessGuards } from "./process-guards.js";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { liveProgramCount } from "./program/runner.js";
import { globalParkTable } from "./program/park.js";
const TEST_PLAN = "Wait for the physical server test to complete and preserve its actual result.";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = mkdtempSync(join(tmpdir(), "localspace-srv-"));
const configDir = join(root, ".localspace");
mkdirSync(configDir, { recursive: true });
mkdirSync(join(root, "proj"), { recursive: true });
writeFileSync(join(root, "proj", "a.txt"), "hello\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (authMode: string) => ({
  HOME: root,
  LOCALSPACE_CONFIG_DIR: configDir,
  LOCALSPACE_STATE_DIR: join(root, `state-${authMode}`),
  LOCALSPACE_ALLOWED_ROOTS: root,
  LOCALSPACE_AUTH_MODE: authMode, // "none" is test-only: local ephemeral server
  LOCALSPACE_OAUTH_OWNER_TOKEN: "test-only-owner-token",
  LOCALSPACE_HOST: "127.0.0.1",
  LOCALSPACE_PORT: "0",
  LOCALSPACE_LOG_REQUESTS: "false",
  LOCALSPACE_AUDIT_LOG: "false",
});
async function listen(authMode: string) {
  const server = createServer(loadConfig(env(authMode)));
  const http = server.app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const stop = async () => {
    await server.close();
    http.closeAllConnections();
    http.close();
  };
  return { base, stop };
}
const listenWith = (authMode: string, extra: Record<string, string>) => {
  const server = createServer(loadConfig({ ...env(authMode), ...extra }));
  const http = server.app.listen(0, "127.0.0.1");
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    http.once("listening", () => {
      resolve({
        base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
        close: async () => {
          await server.close();
          http.closeAllConnections();
          http.close();
        },
      });
    });
  });
};

const { base, stop } = await listen("none");
const MODERN = "2026-07-28";

async function client(modern = false) {
  const c = new Client({ name: "hardening-test", version: "0" }, modern ? { versionNegotiation: { mode: { pin: MODERN } } } : {});
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return c;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const structured = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;

/** Raw JSON-RPC POST; modern adds the per-request envelope and the SEP-2243 standard headers. */
let rpcId = 0;
function rpc(method: string, params: Record<string, unknown>, opts: { modern?: boolean; signal?: AbortSignal; name?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (opts.modern) {
    Object.assign(headers, { "mcp-protocol-version": MODERN, "mcp-method": method }, opts.name ? { "mcp-name": opts.name } : {});
    params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
      },
    };
  } else if (method !== "initialize") headers["mcp-protocol-version"] = "2025-06-18";
  return fetch(`${base}/mcp`, { method: "POST", headers, signal: opts.signal, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
}

// 2026-07-28: server/discover exposes our instructions; tools/call works with Mcp-Method/Mcp-Name.
{
  const r = await rpc("server/discover", {}, { modern: true });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { result: { supportedVersions: string[]; instructions: string } };
  assert.deepEqual(d.result.supportedVersions, [MODERN]);
  assert.match(d.result.instructions, /open_workspace/);
  const opened = await rpc("tools/call", { name: "open_workspace", arguments: { path: join(root, "proj") } }, { modern: true, name: "open_workspace" });
  assert.equal(opened.status, 200);
  const wid = ((await opened.json()) as { result: { structuredContent: { workspaceId: string } } }).result.structuredContent.workspaceId;
  const called = await rpc("tools/call", { name: "js", arguments: { planB: TEST_PLAN, workspaceId: wid, program: `return 6 * 7; // ${"pad".repeat(200)}` } }, { modern: true, name: "js" });
  assert.equal(called.status, 200);
  const res = ((await called.json()) as { result: { content: { text: string }[]; structuredContent: { value: number } } }).result;
  assert.equal(res.structuredContent.value, 42);
  assert.equal(res.content.length, 1);
  const t = res.content[0]!.text;
  const sep = t.indexOf("\u0000\uFEFF");
  assert.ok(sep > 0 && t.slice(0, sep).startsWith("status: done"), "body first");

  // workspaceId is optional: the most recent workspace is reused.
  const omitted = await rpc("tools/call", { name: "js", arguments: { planB: TEST_PLAN, program: `return 6 * 7; // ${"pad".repeat(200)}` } }, { modern: true, name: "js" });
  // Raw JSON-RPC response; shape is asserted by the test itself.
  const omittedBody = (await omitted.json()) as { result: { structuredContent: { value: number } } };
  const omittedResult = omittedBody.result;
  assert.equal(omittedResult.structuredContent.value, 42);

  // A lost/corrupted id fails with candidates and a recovery instruction, not a dead end.
  const bogus = await rpc("tools/call", { name: "js", arguments: { planB: TEST_PLAN, workspaceId: "ws_000000000000", program: "return 1" } }, { modern: true, name: "js" });
  const bogusBody = (await bogus.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const bogusResult = bogusBody.result;
  assert.equal(bogusResult.isError, true);
  assert.match(bogusResult.content[0]!.text, /省略 workspaceId/);
  assert.match(bogusResult.content[0]!.text, new RegExp(wid));
  console.log("2026-07-28 server/discover + tools/call: ok");
}

// 2025-era: initialize + tools/call answer application/json (not SSE).
{
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } });
  assert.equal(init.status, 200);
  assert.match(init.headers.get("content-type") ?? "", /^application\/json/);
  assert.match(((await init.json()) as { result: { instructions: string } }).result.instructions, /open_workspace/);
  const list = await rpc("tools/list", {});
  assert.equal(list.status, 200);
  assert.match(list.headers.get("content-type") ?? "", /^application\/json/);
  const names = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["js", "open_workspace"]);
  console.log("2025-era initialize + tools/list are JSON: ok");
}

const a = await client();
const opened = await a.callTool({ name: "open_workspace", arguments: { path: join(root, "proj") } });
const workspaceId = structured(opened).workspaceId as string;
assert.ok(workspaceId, text(opened));

// SDK clients on both eras.
{
  const m = await client(true);
  assert.equal(m.getProtocolEra(), "modern");
  const r = await m.callTool({ name: "js", arguments: { planB: TEST_PLAN, workspaceId, program: `return 1 + 1; // ${"pad".repeat(200)}` } });
  assert.equal(structured(r).value, 2, text(r));
  await m.close();
  assert.equal(a.getProtocolEra(), "legacy");
  console.log("SDK client modern + legacy eras: ok");
}

// Client disconnect keeps the program alive and leaves a claimable park, on both eras.
for (const modern of [false, true]) {
  const ac = new AbortController();
  const program = `await new Promise(() => {});`;
  const pending = rpc("tools/call", { name: "js", arguments: { planB: TEST_PLAN, workspaceId, program } }, { modern, name: "js", signal: ac.signal }).catch(() => undefined);
  await sleep(100);
  assert.equal(liveProgramCount(), 1);
  ac.abort();
  await pending;
  await sleep(200);
  assert.equal(liveProgramCount(), 1, "a disconnected program must keep running");
  const parked = globalParkTable.list(workspaceId);
  assert.ok(parked.length >= 1, "a disconnected program must leave a claimable park");
  const taken = globalParkTable.take(parked[parked.length - 1]!.handle, workspaceId);
  assert.equal(taken.status, "ok");
  await (taken as { site: { abandon: () => Promise<void> } }).site.abandon();
  for (let i = 0; i < 80 && liveProgramCount(); i++) await sleep(50);
  assert.equal(liveProgramCount(), 0);
  console.log(`${modern ? "2026-07-28" : "2025-era"} client disconnect keeps program + park: ok`);
}

// A long-running call parks on its planB budget; healthz and another tool call stay fast.
const busyStarted = Date.now();
const sleepCommand = 'node -e "process.stdin.resume()"';
const busy = a.callTool({
  name: "js",
  arguments: { planB: "planB", workspaceId, program: `await this.call(${JSON.stringify(sleepCommand)});` },
});
await sleep(200);
const hz = Date.now();
const health = await (await fetch(`${base}/healthz`)).json();
assert.ok(Date.now() - hz < 500, "healthz blocked");
assert.equal(health.livePrograms, 1);
const b = await client(true);
const quickStarted = Date.now();
const quick = await b.callTool({ name: "js", arguments: { planB: TEST_PLAN, workspaceId, program: `return 6 * 7; // ${"pad".repeat(300)}` } });
assert.ok(Date.now() - quickStarted < 1500, `second call took ${Date.now() - quickStarted}ms`);
assert.equal(structured(quick).value, 42);
const parked = structured(await busy);
assert.equal(parked.status, "parked");
assert.equal((parked.parked as { kind: string }).kind, "yield");
assert.ok(Date.now() - busyStarted < 4000);
const handle = (parked.parked as { handle: string }).handle;
const gone = await b.callTool({ name: "js", arguments: { planB: TEST_PLAN, workspaceId, program: `await this.abandon(${JSON.stringify(handle)}); return "ok"; // ${"pad".repeat(200)}` } });
assert.equal(structured(gone).value, "ok", text(gone));
await sleep(100);
assert.equal(liveProgramCount(), 0);
console.log("long call parks without blocking HTTP/MCP: ok");

// A program body over express's old 100kb default is accepted.
const bigProgram = `const s = ${JSON.stringify("x".repeat(300_000))}; return s.length;`;
const big = await b.callTool({ name: "js", arguments: { planB: TEST_PLAN, workspaceId, program: bigProgram } });
assert.equal(structured(big).value, 300_000, text(big));
console.log("300KB request body accepted: ok");

await a.close();
await b.close();
await stop();

// OAuth mode: a bad bearer token is 401 with a challenge, not 500.
{
  const o = await listen("oauth");
  const cfg = loadConfig(env("oauth"));
  const store = new SqliteOAuthStore(cfg.stateDir);
  const client_ = new SqliteOAuthClientsStore(store, cfg.oauth.allowedRedirectHosts).registerClient({ redirect_uris: ["http://localhost/cb"] });
  const grant = { clientId: client_.client_id, scopes: ["localspace"], expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: new URL("/mcp", cfg.publicBaseUrl).href };
  const hash = (t: string) => createHash("sha256").update(t).digest("base64url");
  assert.ok(store.saveTokenPair({ accessTokenHash: hash("good-token"), accessToken: grant, refreshTokenHash: hash("good-refresh"), refreshToken: grant }));
  store.close();
  const ok = await fetch(`${o.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer good-token", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  console.log("valid bearer -> 200: ok");

  // Grok-style connector: no OAuth flow, one fixed token via header or ?token=.
  const staticToken = "static-connector-token-0123456789";
  const s = await listenWith("oauth", { LOCALSPACE_MCP_TOKEN: staticToken });
  const viaHeader = await fetch(`${s.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${staticToken}`, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(viaHeader.status, 200, await viaHeader.clone().text());
  const viaQuery = await fetch(`${s.base}/mcp?token=${staticToken}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(viaQuery.status, 200, await viaQuery.clone().text());
  const wrongToken = await fetch(`${s.base}/mcp?token=${staticToken}x`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(wrongToken.status, 401, await wrongToken.clone().text());
  await s.close();
  console.log("static connector token via header and ?token=: ok");
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    assert.equal((await fetch(`${o.base}${path}`)).status, 200, path);
  }
  const reg = await fetch(`${o.base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost/cb"] }) });
  assert.equal(reg.status, 201);
  console.log("legacy AS metadata + DCR: ok");
  for (const auth of ["Bearer not-a-real-token", undefined]) {
    const r = await fetch(`${o.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(r.status, 401, `auth=${auth}`);
    assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer .*resource_metadata=/);
  }
  await o.stop();
  console.log("bad/missing bearer -> 401: ok");
  await sleep(100);
  const dir = join(root, "state-oauth", "traffic");
  const lines = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l));
  const logged = lines.find((l) => l.headers?.authorization);
  assert.equal(logged?.headers.authorization, "[redacted]");
  assert.equal(logged?.headers["content-type"], "application/json");
  console.log("traffic log records headers with authorization redacted: ok");

// A stray async throw is recorded and the process keeps serving instead of exiting.
{
  const seen: string[] = [];
  installProcessGuards({ logging: loadConfig(env("none")).logging, onError: (kind) => seen.push(kind) });
  void Promise.reject(new Error("boom"));
  await sleep(50);
  assert.deepEqual(seen, ["unhandled_rejection"]);
  console.log("process guard keeps serving: ok");
}
}
console.log("server-hardening.test.ts: all ok");

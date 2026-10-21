import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig, parseTrustProxy } from "./config.js";
import { createServer } from "./server.js";

// parseTrustProxy: never "trust everyone"
assert.equal(parseTrustProxy(undefined), false);
assert.equal(parseTrustProxy(""), false);
assert.equal(parseTrustProxy("0"), false);
assert.equal(parseTrustProxy("false"), false);
assert.equal(parseTrustProxy("true"), "loopback");
assert.equal(parseTrustProxy("1"), "loopback");
assert.equal(parseTrustProxy(true), "loopback");
assert.equal(parseTrustProxy("hops:2"), 2);
assert.equal(parseTrustProxy(2), 2);
assert.equal(parseTrustProxy("loopback, 10.0.0.0/8"), "loopback, 10.0.0.0/8");
assert.throws(() => parseTrustProxy("hops:0"));
console.log("parseTrustProxy: ok");

const stateDir = mkdtempSync(join(tmpdir(), "localspace-trust-proxy-"));
const config = loadConfig({
  LOCALSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-for-unit-tests-only",
  LOCALSPACE_ALLOWED_ROOTS: stateDir,
  LOCALSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  LOCALSPACE_STATE_DIR: stateDir,
  LOCALSPACE_CONFIG_DIR: join(stateDir, "cfg"),
  LOCALSPACE_AUDIT_LOG: "0",
  LOCALSPACE_LOG_REQUESTS: "1",
  LOCALSPACE_TRUST_PROXY: "true",
} as NodeJS.ProcessEnv);
assert.equal(config.logging.trustProxy, "loopback");

const { app, close } = createServer(config);
assert.equal(app.get("trust proxy fn")("127.0.0.1", 0), true, "loopback hop trusted");
assert.equal(app.get("trust proxy fn")("203.0.113.9", 0), false, "public hop not trusted");

const logged: string[] = [];
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
const capture = (...args: unknown[]) => logged.push(args.map(String).join(" "));
console.log = capture;
console.error = capture;
console.warn = capture;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const { port } = server.address() as AddressInfo;
try {
  // Edge proxy sets X-Forwarded-For to the real client; arrives via loopback (frpc).
  for (const ip of ["198.51.100.7", "198.51.100.8"]) {
    await fetch(`http://127.0.0.1:${port}/authorize?client_id=x`, {
      headers: { "X-Forwarded-For": ip, Host: "127.0.0.1:7676" },
    });
  }
  // Client-forged left-most entry must not win over what the trusted proxy appended.
  await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { "X-Forwarded-For": "6.6.6.6, 198.51.100.9", Host: "127.0.0.1:7676" },
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await close?.();
  console.log = origLog;
  console.error = origErr;
  console.warn = origWarn;
  rmSync(stateDir, { recursive: true, force: true });
}

const all = logged.join("\n");
assert.ok(!all.includes("ERR_ERL_PERMISSIVE_TRUST_PROXY"), "no permissive trust proxy warning");
assert.ok(!all.includes("ERR_ERL_UNEXPECTED_X_FORWARDED_FOR"), "no unexpected XFF warning");
const ips = logged
  .filter((l) => l.includes('"event":"http_request"'))
  .map((l) => (JSON.parse(l) as { ip?: string }).ip);
assert.ok(ips.includes("198.51.100.7") && ips.includes("198.51.100.8"), `real client IPs: ${ips}`);
assert.ok(ips.includes("198.51.100.9") && !ips.includes("6.6.6.6"), `rightmost untrusted wins: ${ips}`);
console.log("trust-proxy.test.ts: ok");

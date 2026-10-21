import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "../src/oauth-store.ts";
import { createServer } from "../src/server.ts";

const accessToken = "benchmark-access-token";
const refreshToken = "benchmark-refresh-token";
const outputPath = argumentValue("--output");
const root = await mkdtemp(join(tmpdir(), "localspace-mcp-benchmark-"));

try {
  await createFixture(root);
  const config = benchmarkConfig(root);
  seedOAuthToken(config, accessToken, refreshToken);
  const server = await startServer(config);

  try {
    const measurements = {};
    const initialize = await timed(() => mcpRequest(server.baseUrl, initializeRequest()));
    measurements.initializeMs = initialize.ms;
    await jsonRpcResult(initialize.value);

    const sequentialToolLists = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await timed(() => mcpRequest(server.baseUrl, toolsListRequest(10 + index)));
      sequentialToolLists.push(result.ms);
      await jsonRpcResult(result.value);
    }
    measurements.toolsListSequentialMs = sequentialToolLists;
    measurements.toolsListSequentialSummary = summarize(sequentialToolLists);

    const concurrentLists = await timed(() => Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        mcpRequest(server.baseUrl, toolsListRequest(100 + index)),
      ),
    ));
    for (const response of concurrentLists.value) await jsonRpcResult(response);
    measurements.toolsListConcurrent8Ms = concurrentLists.ms;

    const opened = await timed(() => mcpRequest(
      server.baseUrl,
      callToolRequest(200, "open_workspace", { path: root }),
    ));
    const openResult = await jsonRpcResult(opened.value);
    const workspaceId = recordValue(openResult.structuredContent, "workspaceId");
    assert.equal(typeof workspaceId, "string");
    measurements.openWorkspaceMs = opened.ms;

    measurements.workspaceInfoMs = await callDuration(
      server.baseUrl,
      callToolRequest(201, "workspace_info", { workspaceId }),
    );
    measurements.readPackageMs = await callDuration(
      server.baseUrl,
      callToolRequest(202, "read", { workspaceId, path: "package.json" }),
    );
    const sequentialReads = await timed(async () => {
      for (const [id, path] of [
        [220, "package.json"],
        [221, "src/sample.ts"],
        [222, "src/other.ts"],
      ]) {
        const response = await mcpRequest(
          server.baseUrl,
          callToolRequest(id, "read", { workspaceId, path }),
        );
        await jsonRpcResult(response);
      }
    });
    measurements.readThreeSequentialMs = sequentialReads.ms;

    const batchRead = await timed(() => mcpRequest(
      server.baseUrl,
      callToolRequest(223, "read_many", {
        workspaceId,
        files: [
          { path: "package.json" },
          { path: "src/sample.ts" },
          { path: "src/other.ts" },
        ],
      }),
    ));
    const batchReadResult = await jsonRpcResult(batchRead.value);
    const batchReadSummary = recordValue(batchReadResult.structuredContent, "summary");
    assert.equal(recordValue(batchReadSummary, "succeeded"), 3);
    measurements.readManyThreeMs = batchRead.ms;
    measurements.grepExportMs = await callDuration(
      server.baseUrl,
      callToolRequest(203, "grep", { workspaceId, pattern: "export", path: "src" }),
    );
    measurements.projectMapMs = await callDuration(
      server.baseUrl,
      callToolRequest(204, "project_map", { workspaceId, depth: 3, maxEntries: 100 }),
    );

    const sequentialChecks = await timed(async () => {
      for (const [id, check] of [
        [230, "check:a"],
        [231, "check:b"],
      ]) {
        const response = await mcpRequest(
          server.baseUrl,
          callToolRequest(id, "exec_command", {
            workspaceId,
            cmd: `npm run ${check}`,
            yieldTimeMs: 5_000,
          }),
        );
        const result = await jsonRpcResult(response);
        assert.equal(recordValue(result.structuredContent, "running"), false);
        assert.equal(recordValue(result.structuredContent, "exitCode"), 0);
      }
    });
    measurements.checksTwoSequentialExecMs = sequentialChecks.ms;

    const groupedChecks = await timed(() => mcpRequest(
      server.baseUrl,
      callToolRequest(232, "run_checks", {
        workspaceId,
        checks: ["check:a", "check:b"],
        concurrency: 2,
        yieldTimeMs: 5_000,
      }),
    ));
    const groupedChecksResult = await jsonRpcResult(groupedChecks.value);
    const groupedChecksStructured = groupedChecksResult.structuredContent;
    const groupedChecksSummary = recordValue(groupedChecksStructured, "checkSummary");
    assert.equal(recordValue(groupedChecksStructured, "running"), false);
    assert.equal(recordValue(groupedChecksSummary, "passed"), 2);
    assert.equal(recordValue(groupedChecksSummary, "failed"), 0);
    measurements.checksTwoRunChecksMs = groupedChecks.ms;

    const startA = await timed(() => mcpRequest(
      server.baseUrl,
      callToolRequest(205, "exec_command", {
        workspaceId,
        cmd: "node -e \"setTimeout(() => console.log('benchmark-a'), 300)\"",
        yieldTimeMs: 0,
      }),
    ));
    const startAResult = await jsonRpcResult(startA.value);
    const sessionA = recordValue(startAResult.structuredContent, "sessionId");
    assert.equal(typeof sessionA, "number");

    const startB = await timed(() => mcpRequest(
      server.baseUrl,
      callToolRequest(206, "exec_command", {
        workspaceId,
        cmd: "node -e \"setTimeout(() => console.log('benchmark-b'), 300)\"",
        yieldTimeMs: 0,
      }),
    ));
    const startBResult = await jsonRpcResult(startB.value);
    const sessionB = recordValue(startBResult.structuredContent, "sessionId");
    assert.equal(typeof sessionB, "number");
    measurements.processStartAMs = startA.ms;
    measurements.processStartBMs = startB.ms;

    const processPoll = await timed(() => Promise.all([
      mcpRequest(
        server.baseUrl,
        callToolRequest(207, "write_stdin", {
          workspaceId,
          sessionId: sessionA,
          yieldTimeMs: 5_000,
        }),
      ),
      mcpRequest(
        server.baseUrl,
        callToolRequest(208, "write_stdin", {
          workspaceId,
          sessionId: sessionB,
          yieldTimeMs: 5_000,
        }),
      ),
    ]));
    const [pollA, pollB] = await Promise.all(processPoll.value.map(jsonRpcResult));
    assert.equal(recordValue(pollA.structuredContent, "exitCode"), 0);
    assert.equal(recordValue(pollB.structuredContent, "exitCode"), 0);
    measurements.processConcurrentPollMs = processPoll.ms;

    const sessionSummary = await timed(() => mcpRequest(
      server.baseUrl,
      callToolRequest(209, "session_summary", { workspaceId, limit: 100 }),
    ));
    const sessionSummaryResult = await jsonRpcResult(sessionSummary.value);
    const sessionSummaryStructured = sessionSummaryResult.structuredContent;
    const requestMetrics = recordValue(sessionSummaryStructured, "requestMetrics");
    const toolStats = recordValue(sessionSummaryStructured, "toolStats");
    assert.ok(requestMetrics && typeof requestMetrics === "object");
    assert.ok(toolStats && typeof toolStats === "object");
    measurements.sessionSummaryMs = sessionSummary.ms;

    const output = {
      schemaVersion: 2,
      productBaselineVersion: "v1.0.6",
      productBaselineCommit: "1a4b0c2",
      captureCommit: gitCommit(),
      capturedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        transport: "stateless",
        toolMode: "hybrid",
        toolPacks: [],
        widgets: "off",
        fixture: "temporary local Git repository",
      },
      scope: {
        timing: "client-observed loopback round trip",
        includes: ["HTTP", "OAuth verification", "stateless MCP server creation", "tool execution", "JSON response"],
        excludes: ["ChatGPT model latency", "public tunnel latency", "browser UI rendering"],
      },
      measurements,
      serverObservedRequestMetrics: requestMetrics,
      serverObservedToolActivity: {
        totalEvents: recordValue(sessionSummaryStructured, "totalEvents"),
        averageDurationMs: recordValue(sessionSummaryStructured, "averageDurationMs"),
        maxDurationMs: recordValue(sessionSummaryStructured, "maxDurationMs"),
        categories: recordValue(sessionSummaryStructured, "categories"),
        concurrencyClasses: recordValue(sessionSummaryStructured, "concurrencyClasses"),
        toolStats,
      },
      outcomes: {
        toolsListConcurrentRequests: 8,
        independentProcessesCompleted: 2,
        sequentialPackageChecksCompleted: 2,
        groupedPackageChecksCompleted: 2,
      },
    };

    const json = `${JSON.stringify(output, null, 2)}\n`;
    if (outputPath) {
      const absolute = resolve(outputPath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, json, "utf8");
    }
    process.stdout.write(json);
  } finally {
    await server.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createFixture(root) {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "localspace-benchmark-fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        "check:a": "node -e \"setTimeout(() => console.log('check-a'), 1000)\"",
        "check:b": "node -e \"setTimeout(() => console.log('check-b'), 1000)\"",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, "src", "sample.ts"), "export const sample = 1;\n", "utf8");
  await writeFile(
    join(root, "src", "other.ts"),
    "import { sample } from './sample.js';\nexport const other = sample + 1;\n",
    "utf8",
  );
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["config", "user.name", "LocalSpace Benchmark"], { cwd: root });
  execFileSync("git", ["config", "user.email", "benchmark@localspace.invalid"], { cwd: root });
  execFileSync("git", ["add", "--", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "benchmark fixture"], { cwd: root, stdio: "ignore" });
}

function benchmarkConfig(root) {
  const stateDir = join(root, ".benchmark-state");
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "benchmark-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 2_592_000,
      scopes: ["localspace"],
      allowedRedirectHosts: ["localhost"],
    },
    allowedRoots: [root],
    allowedHosts: ["*"],
    publicBaseUrl: "http://127.0.0.1:7676",
    toolMode: "hybrid",
    toolPacks: [],
    widgets: "off",
    stateDir,
    worktreeRoot: join(root, ".benchmark-worktrees"),
    skillsEnabled: false,
    skillPaths: [],
    agentDir: join(root, ".benchmark-agent"),
    logging: {
      level: "warn",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
    audit: {
      enabled: false,
      path: join(stateDir, "audit.jsonl"),
      maxMemoryEvents: 100,
    },
    concurrency: {
      maxConcurrentToolCalls: 8,
      maxConcurrentScans: 2,
      maxConcurrentProcesses: 4,
      maxWorkspaceProcesses: 2,
      queueTimeoutMs: 120_000,
    },
  };
}

function seedOAuthToken(config, access, refresh) {
  const store = new SqliteOAuthStore(config.stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, config.oauth.allowedRedirectHosts).registerClient({
      redirect_uris: ["http://localhost/callback"],
      client_name: "LocalSpace MCP benchmark",
    });
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const saved = store.saveTokenPair({
      accessTokenHash: hashToken(access),
      accessToken: {
        clientId: client.client_id,
        scopes: ["localspace"],
        expiresAt,
        resource: new URL("/mcp", config.publicBaseUrl).href,
      },
      refreshTokenHash: hashToken(refresh),
      refreshToken: {
        clientId: client.client_id,
        scopes: ["localspace"],
        expiresAt,
        resource: new URL("/mcp", config.publicBaseUrl).href,
      },
    });
    assert.equal(saved, true);
  } finally {
    store.close();
  }
}

async function startServer(config) {
  const running = createServer(config);
  const httpServer = await listen(running.app.listen(0, config.host));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://${config.host}:${address.port}`,
    close: async () => {
      await running.close();
      await closeHttpServer(httpServer);
    },
  };
}

async function listen(server) {
  if (server.listening) return server;
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function callDuration(baseUrl, request) {
  const result = await timed(() => mcpRequest(baseUrl, request));
  await jsonRpcResult(result.value);
  return result.ms;
}

async function timed(callback) {
  const started = performance.now();
  const value = await callback();
  return { value, ms: round(performance.now() - started) };
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
    mean: round(total / sorted.length),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function mcpRequest(baseUrl, body) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
  });
}

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "localspace-benchmark", version: "1.0.0" },
    },
  };
}

function toolsListRequest(id) {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

function callToolRequest(id, name, args) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function jsonRpcResult(response) {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error, undefined);
  assert.ok(body.result && typeof body.result === "object" && !Array.isArray(body.result));
  return body.result;
}

function recordValue(record, key) {
  assert.ok(record && typeof record === "object" && !Array.isArray(record));
  return record[key];
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("base64url");
}

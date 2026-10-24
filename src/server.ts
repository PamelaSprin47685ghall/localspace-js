import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  checkResourceAllowed,
  createMcpHandler,
  isLegacyRequest,
  resourceUrlFromServerUrl,
  type McpHandlerRequestOptions,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidation,
  localhostHostValidation,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { mcpAuthRouter } from "@modelcontextprotocol/server-legacy/auth";
import express, { type Express, type RequestHandler } from "express";
import type { Request, Response } from "express";
import { loadConfig, type ServerConfig } from "./config.js";
import { logEvent, requestIp, requestPath } from "./logger.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { AuditLogManager } from "./audit-log.js";
import { ToolActivityLogManager } from "./activity-log.js";
import { trafficLog } from "./traffic-log.js";
import { registerJsSurface } from "./program/tools.js";
import { globalParkTable } from "./program/park.js";
import { liveProgramCount, shutdownPrograms } from "./program/runner.js";
import { shutdownSembleClients } from "./program/semble.js";
import { startEventLoopMonitor } from "./event-loop-monitor.js";
import { inflightSnapshot } from "./inflight.js";

/** JSON-RPC body limit. express.json()'s 100kb default rejected long js programs with 413. */
const MCP_BODY_LIMIT = "8mb";
const MCP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** Same host validation as the SDK's createMcpExpressApp, with our body limit. */
function createMcpApp(host: string, allowedHosts?: string[]): Express {
  const app = express();
  app.use(express.json({ limit: MCP_BODY_LIMIT }));
  if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));
  else if (["127.0.0.1", "localhost", "::1"].includes(host)) app.use(localhostHostValidation());
  return app;
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };
const LOCALSPACE_VERSION =
  typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "0.0.0";

export interface RunningServer {
  app: Express;
  config: ServerConfig;
  close: () => Promise<void>;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req),
    host: req.headers.host,
    userAgent: req.headers["user-agent"],
    publicBaseUrl: config.publicBaseUrl,
  };
}

function mcpRpcRequestInfo(body: unknown): {
  rpcMethod?: string;
  tool?: string;
  workspaceId?: string;
} {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const rpcMethod = typeof record.method === "string" ? record.method : undefined;
  const params = record.params && typeof record.params === "object"
    ? (record.params as Record<string, unknown>)
    : undefined;
  const tool = typeof params?.name === "string" ? params.name : undefined;
  const args = params?.arguments && typeof params.arguments === "object"
    ? (params.arguments as Record<string, unknown>)
    : undefined;
  const workspaceId = typeof args?.workspaceId === "string" ? args.workspaceId : undefined;
  return { rpcMethod, tool, workspaceId };
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  auditLog: AuditLogManager,
  activityLog: ToolActivityLogManager,
): McpServer {
  const server = new McpServer(
    {
      name: "localspace-js",
      title: "LocalSpace JS",
      version: LOCALSPACE_VERSION,
      description: "本地工作区 MCP：open_workspace + js 编程面。",
    },
    {
      instructions:
        "使用 open_workspace 打开目录，然后用 js 运行平铺的异步 JavaScript 程序。" +
        "全部原语均为 this 成员：this.cat/stat/ls/search/findRelated/where/whereAll/write/mkdir/mv/rm/call/signal/send/park，" +
        "以及 this.unpark(handle,value?)/this.abandon(handle)。js 顶层必填 program 和非空 planB；其 UTF-8 字节数 × 50ms 是整个请求的统一等待时限，包含 worker 启动、计算、全部 this.call(command) 和 unpark。恢复目标共用控制请求已有期限，程序内的变量和参数不能续期。" +
        "where 为字面匹配；危险操作与 where 歧义会 park。互不相干的任务可并行调用 js。" +
        "工具结果中 NUL+BOM 之后是 Host Pair Hint。",
    },
  );
  registerJsSurface(server, {
    config,
    workspaces,
    auditLog,
    activityLog,
    configDir: config.configDir,
  });
  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpApp(config.host, allowedHosts);
  globalParkTable.ttlMs = config.parkTtlMs;
  const loopMonitor = startEventLoopMonitor({
    onLag: (lag) =>
      logEvent(config.logging, "warn", "event_loop_lag", { ...lag, livePrograms: liveProgramCount() }),
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "localspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const authenticate: RequestHandler =
    config.authMode === "none"
      ? (req, _res, next) => {
          req.auth = { token: "", clientId: "local", scopes: [], resource: resourceServerUrl };
          next();
        }
      : (req, res, next) => {
          // Grok (and other connectors that only accept a URL) cannot fill the interactive
          // owner-password form: accept one fixed token, as a bearer header or `?token=`.
          if (matchesStaticToken(req, config.mcpToken)) {
            req.auth = {
              token: "",
              clientId: "static-token",
              scopes: [config.oauth.scopes[0] ?? "localspace"],
              resource: resourceServerUrl,
            };
            next();
            return;
          }
          bearerAuth(req, res, next);
        };
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const auditLog = new AuditLogManager(config.audit);
  const activityLog = new ToolActivityLogManager(config.audit.maxMemoryEvents);
  // Trust only the real proxy hop(s) so req.ip (and express-rate-limit keys) is the real client IP.
  if (config.logging.trustProxy !== false) {
    app.set("trust proxy", config.logging.trustProxy);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;
    res.on("finish", () => {
      if (!config.logging.requests) return;
      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path: requestPath(req),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });
    next();
  });

  if (config.authMode !== "none") {
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: "LocalSpace",
      }),
    );
  }

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "localspace-js",
      tools: ["open_workspace", "js"],
      eventLoopLag: loopMonitor.last(),
      livePrograms: liveProgramCount(),
      parked: globalParkTable.size,
      inFlight: inflightSnapshot(),
    });
  });

  app.use("/mcp", trafficLog(config.stateDir, !/^(0|false|off)$/i.test(process.env.LOCALSPACE_TRAFFIC_LOG ?? "")));

  // One factory serves both eras: 2026-07-28 (server/discover, per-request envelope) via createMcpHandler,
  // 2025-era (initialize handshake) via a stateless JSON transport so legacy replies stay application/json.
  const factory = () => createMcpServer(config, workspaces, auditLog, activityLog);
  const current = new AsyncLocalStorage<Request>();
  const onerror = (error: Error) => logTransportError(config, current.getStore(), error);
  const modern = createMcpHandler(factory, { legacy: "reject", onerror, maxRequestBodySize: MCP_BODY_LIMIT_BYTES });
  const legacy = async (request: globalThis.Request, options?: McpHandlerRequestOptions) => {
    if (request.method !== "POST") {
      return globalThis.Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed in stateless mode" }, id: null },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transport.onerror = onerror;
    await server.connect(transport);
    // Client gone before the reply: closing the server aborts in-flight handlers (ctx.mcpReq.signal),
    // which kills the program's worker and process groups. The modern path does the same internally.
    const close = () => void server.close().catch(() => undefined);
    request.signal.addEventListener("abort", close, { once: true });
    try {
      return await transport.handleRequest(request, options);
    } finally {
      request.signal.removeEventListener("abort", close);
      close();
    }
  };
  const mcp = toNodeHandler(
    {
      fetch: async (request, options) =>
        (await isLegacyRequest(request, options?.parsedBody)) ? legacy(request, options) : modern.fetch(request, options),
    },
    { onerror, maxRequestBodySize: MCP_BODY_LIMIT_BYTES },
  );

  app.all("/mcp", authenticate, async (req, res) => {
    try {
      if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }
      await current.run(req, () => mcp(req, res, req.body));
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId: res.locals.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    close: () => {
      closePromise ??= (async () => {
        await modern.close();
        globalParkTable.clear();
        shutdownPrograms();
        shutdownSembleClients();
        loopMonitor.stop();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

/** Constant-time check of the fixed token in `Authorization: Bearer …` or `?token=…`. */
function matchesStaticToken(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  const query = typeof req.query.token === "string" ? req.query.token.trim() : undefined;
  const provided = bearer || query;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The SDK answers malformed/unsupported requests with 4xx itself; record why. */
function logTransportError(config: ServerConfig, req: Request | undefined, error: Error): void {
  logEvent(config.logging, "warn", "mcp_transport_error", {
    requestId: req?.res?.locals.requestId,
    error: error.message,
    httpMethod: req?.method,
    rpcMethod: mcpRpcRequestInfo(req?.body).rpcMethod,
    protocolVersion: req?.header("mcp-protocol-version"),
    mcpMethod: req?.header("mcp-method"),
    accept: req?.header("accept"),
    contentType: req?.header("content-type"),
    userAgent: req?.header("user-agent"),
  });
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close } = createServer();
  const { installProcessGuards } = await import("./process-guards.js");
  installProcessGuards({ logging: config.logging });
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`localspace-js listening on http://${config.host}:${config.port}/mcp`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`auth: ${config.authMode}`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("localspace-js shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

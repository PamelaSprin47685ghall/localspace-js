import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { Request, Response } from "express";
import { loadConfig, type ServerConfig } from "./config.js";
import { logEvent, requestIp, requestPath, sessionIdPrefix } from "./logger.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { McpSessionRegistry, type McpSessionRegistryEvent } from "./mcp-session-registry.js";
import { AuditLogManager } from "./audit-log.js";
import { ToolActivityLogManager } from "./activity-log.js";
import { McpRequestMetricsManager, type RequestConnectionOutcome } from "./request-metrics.js";
import { registerJsSurface } from "./program/tools.js";
import { globalParkTable } from "./program/park.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };
const LOCALSPACE_VERSION =
  typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "0.0.0";

type Transport = StreamableHTTPServerTransport;

export interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
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
    ip: requestIp(req, config.logging.trustProxy),
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

function optionalByteLength(value: string | number | string[] | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return undefined;
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
        "全部原语均为 this 成员：this.cat/stat/ls/rg/where/write/mkdir/mv/rm/call/park，" +
        "以及 this.unpark(handle,arg)/this.abandon(handle)。this.call 支持 spawn/send/signal/waitFor/read/join。" +
        "危险操作与 where 歧义会 park；约每 30 秒自动 yield。互不相干的任务可并行调用 js。" +
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
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = config.mcpTransportMode === "stateful"
    ? new McpSessionRegistry<Transport>(config.mcpSessions, (event) => {
        logMcpSessionEvent(config, event);
      })
    : undefined;
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "localspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const auditLog = new AuditLogManager(config.audit);
  const activityLog = new ToolActivityLogManager(config.audit.maxMemoryEvents);
  const requestMetrics = new McpRequestMetricsManager(config.audit.maxMemoryEvents);
  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
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
    res.json({ ok: true, name: "localspace-js", tools: ["open_workspace", "js"] });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    const rpcInfo = mcpRpcRequestInfo(req.body);
    const requestStartedAt = performance.now();
    let authMs = 0;
    let serverCreateMs = 0;
    let transportConnectMs = 0;
    let transportHandleMs = 0;
    let cleanupMs = 0;
    let handlerFailed = false;

    try {
      const authStartedAt = performance.now();
      try {
        if (config.authMode === "none") {
          (req as { auth?: { resource?: URL } }).auth = { resource: resourceServerUrl };
        } else {
          await new Promise<void>((resolve, reject) => {
            bearerAuth(req, res, (error?: unknown) => {
              if (error) reject(error);
              else resolve();
            });
          });
        }
      } finally {
        authMs = Math.round((performance.now() - authStartedAt) * 100) / 100;
      }
      if (res.headersSent) return;

      if (
        !req.auth?.resource ||
        !checkResourceAllowed({
          requestedResource: req.auth.resource,
          configuredResource: resourceServerUrl,
        })
      ) {
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }

      if (config.mcpTransportMode === "stateless") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          sendJsonRpcError(res, 405, -32000, "Method not allowed in stateless mode");
          return;
        }
        const serverCreateStartedAt = performance.now();
        const statelessTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const statelessServer = createMcpServer(config, workspaces, auditLog, activityLog);
        serverCreateMs = Math.round((performance.now() - serverCreateStartedAt) * 100) / 100;
        const connectStartedAt = performance.now();
        await statelessServer.connect(statelessTransport);
        transportConnectMs = Math.round((performance.now() - connectStartedAt) * 100) / 100;
        try {
          const handleStartedAt = performance.now();
          try {
            await statelessTransport.handleRequest(req, res, req.body);
          } finally {
            transportHandleMs = Math.round((performance.now() - handleStartedAt) * 100) / 100;
          }
        } finally {
          const cleanupStartedAt = performance.now();
          try {
            await statelessServer.close();
          } catch (error) {
            logEvent(config.logging, "warn", "mcp_stateless_cleanup_error", {
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            cleanupMs = Math.round((performance.now() - cleanupStartedAt) * 100) / 100;
          }
        }
        return;
      }

      let transport: Transport | undefined;
      if (!transports) throw new Error("Stateful MCP session registry is unavailable.");
      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32001, "Session not found");
          return;
        }
      } else if (initializeRequest) {
        const serverCreateStartedAt = performance.now();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.add(newSessionId, transport);
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId, "client_closed", { closeTransport: false });
          }
        };
        const server = createMcpServer(config, workspaces, auditLog, activityLog);
        serverCreateMs = Math.round((performance.now() - serverCreateStartedAt) * 100) / 100;
        const connectStartedAt = performance.now();
        await server.connect(transport);
        transportConnectMs = Math.round((performance.now() - connectStartedAt) * 100) / 100;
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      const handleStartedAt = performance.now();
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        transportHandleMs = Math.round((performance.now() - handleStartedAt) * 100) / 100;
      }
    } catch (error) {
      handlerFailed = true;
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
    } finally {
      const totalMs = Math.round((performance.now() - requestStartedAt) * 100) / 100;
      const connectionOutcome: RequestConnectionOutcome = handlerFailed ? "response_error" : "completed";
      requestMetrics.record({
        requestId,
        transportMode: config.mcpTransportMode,
        httpMethod: req.method,
        rpcMethod: rpcInfo.rpcMethod,
        tool: rpcInfo.tool,
        workspaceId: rpcInfo.workspaceId,
        status: res.statusCode,
        success: res.statusCode < 400 && !handlerFailed,
        requestBytes: optionalByteLength(req.header("content-length")),
        responseBytes: optionalByteLength(res.getHeader("content-length") as string | number | string[] | undefined),
        authMs,
        serverCreateMs,
        transportConnectMs,
        transportHandleMs,
        cleanupMs,
        totalMs,
        connectionOutcome,
      });
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    close: () => {
      closePromise ??= (async () => {
        await transports?.closeAll("server_shutdown");
        globalParkTable.clear();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

function logMcpSessionEvent(config: ServerConfig, event: McpSessionRegistryEvent): void {
  logEvent(config.logging, "info", event.action === "created" ? "mcp_session_created" : "mcp_session_closed", {
    sessionIdPrefix: sessionIdPrefix(event.sessionId),
    reason: event.reason,
    activeSessions: event.activeSessions,
    ageMs: event.ageMs,
    idleMs: event.idleMs,
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
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`localspace-js listening on http://${config.host}:${config.port}/mcp`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`auth: ${config.authMode}`);
    console.log(`mcp transport: ${config.mcpTransportMode}`);
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

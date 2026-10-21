import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel, TrustProxy } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { loadLocalspaceFiles } from "./user-config.js";
import { defaultAuditLogPath, type AuditLogConfig } from "./audit-log.js";
import {
  DEFAULT_MCP_MAX_SESSIONS,
  DEFAULT_MCP_SESSION_CLEANUP_INTERVAL_MS,
  DEFAULT_MCP_SESSION_IDLE_TTL_MS,
  type McpSessionConfig,
} from "./mcp-session-registry.js";

export type McpTransportMode = "stateful" | "stateless";
export type AuthMode = "oauth" | "none";
export interface ToolConcurrencyConfig {
  maxConcurrentToolCalls: number;
  maxConcurrentScans: number;
  maxConcurrentProcesses: number;
  maxWorkspaceProcesses: number;
  queueTimeoutMs: number;
}
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_TOOL_CONCURRENCY: ToolConcurrencyConfig = {
  maxConcurrentToolCalls: 8,
  maxConcurrentScans: 2,
  maxConcurrentProcesses: 4,
  maxWorkspaceProcesses: 2,
  queueTimeoutMs: 120_000,
};

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  authMode: AuthMode;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  mcpTransportMode: McpTransportMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  shell?: string;
  logging: LoggingConfig;
  audit: AuditLogConfig;
  mcpSessions: McpSessionConfig;
  concurrency: ToolConcurrencyConfig;
  yieldBudgetMs: number;
  parkTtlMs: number;
  configDir: string;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  const mode = env.LOCALSPACE_AUTH_MODE;
  if (mode === "none" || mode === "oauth") return mode;
  if (mode) throw new Error(`Invalid LOCALSPACE_AUTH_MODE: ${mode}`);
  return "oauth";
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}



function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid LOCALSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid LOCALSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseOptionalPath(value: string | undefined): string | undefined {
  const path = value?.trim();
  if (!path) return undefined;
  return expandHomePath(path);
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

/**
 * Express `trust proxy` setting. Trust only the real proxy hop(s), never everyone:
 * unset/0/false -> false; 1/true/yes/on (legacy flag) -> "loopback" (proxy/tunnel on this host);
 * integer N>=1 given as "hops:N" -> N hops; anything else is passed through to Express
 * (e.g. "loopback", "10.0.0.0/8,127.0.0.1").
 */
export function parseTrustProxy(value: string | number | boolean | undefined): TrustProxy {
  if (value === undefined || value === false || value === "" || value === 0) return false;
  if (value === true) return "loopback";
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid trustProxy: ${value}`);
    return value;
  }
  const raw = value.trim();
  const lower = raw.toLowerCase();
  if (["0", "false", "no", "off"].includes(lower)) return false;
  if (["1", "true", "yes", "on"].includes(lower)) return "loopback";
  const hops = /^hops:(\d+)$/.exec(lower);
  if (hops) {
    const n = Number(hops[1]);
    if (n < 1) throw new Error(`Invalid trustProxy: ${raw}`);
    return n;
  }
  return raw;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv, fileTrustProxy?: string | number | boolean): LoggingConfig {
  return {
    level: parseLogLevel(env.LOCALSPACE_LOG_LEVEL),
    format: parseLogFormat(env.LOCALSPACE_LOG_FORMAT),
    requests: env.LOCALSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.LOCALSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.LOCALSPACE_LOG_ASSETS),
    toolCalls: env.LOCALSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.LOCALSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.LOCALSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseTrustProxy(env.LOCALSPACE_TRUST_PROXY ?? fileTrustProxy),
  };
}

function parseAuditConfig(env: NodeJS.ProcessEnv, stateDir: string): AuditLogConfig {
  return {
    enabled: env.LOCALSPACE_AUDIT_LOG === undefined ? true : parseBoolean(env.LOCALSPACE_AUDIT_LOG),
    path: resolve(expandHomePath(env.LOCALSPACE_AUDIT_LOG_PATH ?? defaultAuditLogPath(stateDir))),
    maxMemoryEvents: parsePositiveInteger(env.LOCALSPACE_AUDIT_MAX_MEMORY_EVENTS, 1_000, "LOCALSPACE_AUDIT_MAX_MEMORY_EVENTS"),
  };
}

function parseMcpSessionConfig(env: NodeJS.ProcessEnv): McpSessionConfig {
  return {
    idleTtlMs: parsePositiveInteger(
      env.LOCALSPACE_MCP_SESSION_IDLE_TTL_MS,
      DEFAULT_MCP_SESSION_IDLE_TTL_MS,
      "LOCALSPACE_MCP_SESSION_IDLE_TTL_MS",
    ),
    cleanupIntervalMs: parsePositiveInteger(
      env.LOCALSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS,
      DEFAULT_MCP_SESSION_CLEANUP_INTERVAL_MS,
      "LOCALSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS",
    ),
    maxSessions: parsePositiveInteger(
      env.LOCALSPACE_MCP_MAX_SESSIONS,
      DEFAULT_MCP_MAX_SESSIONS,
      "LOCALSPACE_MCP_MAX_SESSIONS",
    ),
  };
}

function parseToolConcurrencyConfig(env: NodeJS.ProcessEnv): ToolConcurrencyConfig {
  return {
    maxConcurrentToolCalls: parsePositiveInteger(
      env.LOCALSPACE_MAX_CONCURRENT_TOOL_CALLS,
      DEFAULT_TOOL_CONCURRENCY.maxConcurrentToolCalls,
      "LOCALSPACE_MAX_CONCURRENT_TOOL_CALLS",
    ),
    maxConcurrentScans: parsePositiveInteger(
      env.LOCALSPACE_MAX_CONCURRENT_SCANS,
      DEFAULT_TOOL_CONCURRENCY.maxConcurrentScans,
      "LOCALSPACE_MAX_CONCURRENT_SCANS",
    ),
    maxConcurrentProcesses: parsePositiveInteger(
      env.LOCALSPACE_MAX_CONCURRENT_PROCESSES,
      DEFAULT_TOOL_CONCURRENCY.maxConcurrentProcesses,
      "LOCALSPACE_MAX_CONCURRENT_PROCESSES",
    ),
    maxWorkspaceProcesses: parsePositiveInteger(
      env.LOCALSPACE_MAX_WORKSPACE_PROCESSES,
      DEFAULT_TOOL_CONCURRENCY.maxWorkspaceProcesses,
      "LOCALSPACE_MAX_WORKSPACE_PROCESSES",
    ),
    queueTimeoutMs: parsePositiveInteger(
      env.LOCALSPACE_TOOL_QUEUE_TIMEOUT_MS,
      DEFAULT_TOOL_CONCURRENCY.queueTimeoutMs,
      "LOCALSPACE_TOOL_QUEUE_TIMEOUT_MS",
    ),
  };
}

function parseMcpTransportMode(value: string | undefined): McpTransportMode {
  if (!value || value === "stateless") return "stateless";
  if (value === "stateful") return "stateful";

  throw new Error(`Invalid LOCALSPACE_MCP_TRANSPORT_MODE: ${value}`);
}


function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for LocalSpace OAuth. Run: localspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.LOCALSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "LOCALSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.LOCALSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "LOCALSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.LOCALSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "LOCALSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.LOCALSPACE_OAUTH_SCOPES, ["localspace"]),
    allowedRedirectHosts: parseStringList(env.LOCALSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  const defaultDir = join(homedir(), ".local", "share", "localspace");
  const fallbackDir = join(homedir(), ".local", "share", "devspace");
  if (!existsSync(defaultDir) && existsSync(fallbackDir)) {
    return fallbackDir;
  }
  return defaultDir;
}

function defaultWorktreeRoot(): string {
  const defaultDir = join(homedir(), ".localspace", "worktrees");
  const fallbackDir = join(homedir(), ".devspace", "worktrees");
  if (!existsSync(defaultDir) && existsSync(fallbackDir)) {
    return fallbackDir;
  }
  return defaultDir;
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadLocalspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.LOCALSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];
  const stateDir = resolve(expandHomePath(env.LOCALSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir()));

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.LOCALSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.LOCALSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    authMode: parseAuthMode(env),
    mcpTransportMode: parseMcpTransportMode(env.LOCALSPACE_MCP_TRANSPORT_MODE),
    stateDir,
    configDir: resolve(expandHomePath(env.LOCALSPACE_CONFIG_DIR ?? join(homedir(), ".localspace"))),
    yieldBudgetMs: parsePositiveInteger(env.LOCALSPACE_YIELD_BUDGET_MS, 30_000, "LOCALSPACE_YIELD_BUDGET_MS"),
    parkTtlMs: parsePositiveInteger(env.LOCALSPACE_PARK_TTL_MS, 1_800_000, "LOCALSPACE_PARK_TTL_MS"),
    worktreeRoot: resolve(expandHomePath(env.LOCALSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.LOCALSPACE_SKILLS === undefined ? true : parseBoolean(env.LOCALSPACE_SKILLS),
    skillPaths: parsePathList(env.LOCALSPACE_SKILL_PATHS),
    agentDir: resolve(expandHomePath(env.LOCALSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    shell: parseOptionalPath(env.LOCALSPACE_SHELL ?? files.config.shell),
    logging: parseLoggingConfig(env, files.config.trustProxy),
    audit: parseAuditConfig(env, stateDir),
    mcpSessions: parseMcpSessionConfig(env),
    concurrency: parseToolConcurrencyConfig(env),
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}

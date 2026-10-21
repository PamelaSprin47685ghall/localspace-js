#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import {
  normalizePublicBaseUrl,
  parseInitArgs,
  portValidationError,
  publicBaseUrlValidationError,
  resolveNonInteractiveInit,
  type ParsedInitArgs,
} from "./init-options.js";
import {
  generateOwnerToken,
  loadLocalspaceFiles,
  writeLocalspaceAuth,
  writeLocalspaceConfig,
  type LocalspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { resolveGitExecutable, resolveShellCommand } from "./process-platform.js";

type Command = "serve" | "init" | "doctor" | "config" | "help" | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=22.19 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit(args);
      return;
    case "doctor":
      await runDoctor(args);
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadLocalspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.LOCALSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "LocalSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  localspace init",
        "",
        "Or provide LOCALSPACE_OAUTH_OWNER_TOKEN and LOCALSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit([]);
}

async function runInit(args: string[]): Promise<void> {
  const parsed = parseInitArgs(args);
  if (parsed.nonInteractive) {
    runNonInteractiveInit(parsed);
    return;
  }
  await runInteractiveInit(parsed);
}

function runNonInteractiveInit(parsed: ParsedInitArgs): void {
  const files = loadLocalspaceFiles();
  if (!parsed.force && files.configExists && files.authExists) {
    console.log(`LocalSpace is already configured at ${files.dir}`);
    console.log("Run again with --force to update it.");
    return;
  }

  const resolved = resolveNonInteractiveInit(parsed);
  const config: LocalspaceUserConfig = {
    host: files.config.host ?? "127.0.0.1",
    port: resolved.port,
    allowedRoots: resolved.allowedRoots,
    publicBaseUrl: resolved.publicBaseUrl,
  };
  const auth = {
    ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
  };

  const configPath = writeLocalspaceConfig(config);
  const authPath = writeLocalspaceAuth(auth);

  console.log(`Config: ${configPath}`);
  console.log(`Auth: ${authPath}`);
  console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
  if (resolved.publicBaseUrl) {
    console.log(`Public MCP URL: ${resolved.publicBaseUrl}/mcp`);
  } else {
    console.log("Public MCP URL: not configured (local-only setup)");
  }
  console.log(`Owner password: ${auth.ownerToken}`);
}

async function runInteractiveInit(parsed: ParsedInitArgs): Promise<void> {
  const force = parsed.force;
  const files = loadLocalspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`LocalSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `localspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("LocalSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should LocalSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: portValidationError,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "LocalSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: publicBaseUrlValidationError,
    }));

    const config: LocalspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeLocalspaceConfig(config);
    const authPath = writeLocalspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "LocalSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve LocalSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `localspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteCheck = checkSqliteNative();
  if (!sqliteCheck.ok) {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteCheck.error ?? "unknown error",
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`localspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because LOCALSPACE_ALLOWED_HOSTS=*");
    }
    console.log(`auth: ${config.authMode}`);
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
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
      console.error("localspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

interface DoctorPaths {
  path: string;
  exists: boolean;
}

interface DoctorReport {
  configDir: string;
  config: DoctorPaths;
  auth: DoctorPaths;
  runtime: {
    node: string;
    nodeAbi: string;
    platform: string;
    arch: string;
    supportedRange: string;
    nodeSupported: boolean;
  };
  git: { available: boolean; detail: string };
  bashShell: { available: boolean; detail: string };
  sqliteNative: { ok: boolean; error?: string };
  server?: {
    localMcpUrl: string;
    publicMcpUrl: string;
    allowedRoots: string[];
    allowedHosts: string[];
  };
  configError?: string;
}

async function runDoctor(args: string[]): Promise<void> {
  const report = buildDoctorReport();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printDoctorText(report);
}

function buildDoctorReport(): DoctorReport {
  const files = loadLocalspaceFiles();
  const report: DoctorReport = {
    configDir: files.dir,
    config: { path: files.configPath, exists: files.configExists },
    auth: { path: files.authPath, exists: files.authExists },
    runtime: {
      node: process.version,
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      supportedRange: SUPPORTED_NODE_RANGE,
      nodeSupported: satisfies(process.versions.node, SUPPORTED_NODE_RANGE),
    },
    git: checkGitAvailable(),
    bashShell: checkBashShell(),
    sqliteNative: checkSqliteNative(),
  };

  try {
    const config = loadConfig();
    report.server = {
      localMcpUrl: `http://${config.host}:${config.port}/mcp`,
      publicMcpUrl: new URL("/mcp", config.publicBaseUrl).toString(),
      allowedRoots: [...config.allowedRoots],
      allowedHosts: [...config.allowedHosts],
    };
  } catch (error) {
    report.configError = error instanceof Error ? error.message : String(error);
  }
  return report;
}

function printDoctorText(report: DoctorReport): void {
  const range = report.runtime.supportedRange;
  console.log(`Config dir: ${report.configDir}`);
  console.log(`Config file: ${report.config.exists ? report.config.path : "missing"}`);
  console.log(`Auth file: ${report.auth.exists ? report.auth.path : "missing"}`);
  console.log(
    `Node: ${report.runtime.node} (${
      report.runtime.nodeSupported ? `supported ${range}` : `unsupported, requires ${range}`
    })`,
  );
  console.log(`Node ABI: ${report.runtime.nodeAbi}`);
  console.log(`Platform: ${report.runtime.platform} ${report.runtime.arch}`);
  console.log(`Git: ${report.git.available ? report.git.detail : `unavailable (${report.git.detail})`}`);
  console.log(
    `Bash shell: ${
      report.bashShell.available ? report.bashShell.detail : `unavailable (${report.bashShell.detail})`
    }`,
  );
  console.log(`SQLite native dependency: ${report.sqliteNative.ok ? "ok" : report.sqliteNative.error}`);

  if (report.server) {
    console.log(`Local MCP URL: ${report.server.localMcpUrl}`);
    console.log(`Public MCP URL: ${report.server.publicMcpUrl}`);
    console.log(`Allowed roots: ${report.server.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${report.server.allowedHosts.join(", ")}`);
  } else if (report.configError) {
    console.log(`Config status: ${report.configError}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadLocalspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `localspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeLocalspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "LocalSpace",
      "",
      "Usage:",
      "  localspace                 Run first-time setup if needed, then start the server",
      "  localspace serve           Start the server",
      "  localspace init            Create or update ~/.localspace/config.json and auth.json",
      "  localspace init --non-interactive --roots \"<path1>,<path2>\" --port 7676 --public-base-url <url>",
      "                             Configure without prompts; --public-base-url is optional for",
      "                             local-only setups; add --force to overwrite an existing setup",
      "  localspace doctor          Show config, runtime, and native dependency status",
      "  localspace doctor --json   Print the same doctor report as JSON",
      "  localspace config get      Print persisted config",
      "  localspace config set publicBaseUrl <url|null>",
      "  localspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  LOCALSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com localspace serve",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read LocalSpace package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `LocalSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): { ok: boolean; error?: string } {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function checkGitAvailable(): { available: boolean; detail: string } {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return {
      available: true,
      detail: execFileSync(resolveGitExecutable(), ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
    };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function checkBashShell(): { available: boolean; detail: string } {
  try {
    const { executable, args } = resolveShellCommand("<command>");
    return { available: true, detail: `${executable} ${args.join(" ")}` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

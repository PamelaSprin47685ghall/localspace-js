import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface LocalspaceUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  agentDir?: string;
  shell?: string;
  /** Express trust proxy: false | true(=loopback) | hop count | "loopback" / CIDR list. */
  trustProxy?: string | number | boolean;
}

export interface LocalspaceAuthConfig {
  ownerToken?: string;
}

export interface LocalspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: LocalspaceUserConfig;
  auth: LocalspaceAuthConfig;
}

export function localspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const defaultDir = join(homedir(), ".localspace");
  const fallbackDir = join(homedir(), ".devspace");
  const dir = resolve(expandHomePath(env.LOCALSPACE_CONFIG_DIR ?? env.DEVSPACE_CONFIG_DIR ?? defaultDir));
  if (dir === defaultDir && !existsSync(defaultDir) && existsSync(fallbackDir)) {
    return fallbackDir;
  }
  return dir;
}

export function localspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(localspaceConfigDir(env), "config.json");
}

export function localspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(localspaceConfigDir(env), "auth.json");
}

export function loadLocalspaceFiles(env: NodeJS.ProcessEnv = process.env): LocalspaceFiles {
  const dir = localspaceConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<LocalspaceUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<LocalspaceAuthConfig>(authPath) : {},
  };
}

export function writeLocalspaceConfig(
  config: LocalspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = localspaceConfigPath(env);
  mkdirSync(localspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeLocalspaceAuth(
  auth: LocalspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = localspaceAuthPath(env);
  mkdirSync(localspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { lstat, mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import { resolveGitExecutable } from "./process-platform.js";
import { assertAllowedPath, expandHomePath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";

const execFileAsync = promisify(execFile);

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

type DirectoryOps = {
  stat: (path: string) => Promise<Stats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private lastUsedId?: string;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      this.lastUsedId = workspace.id;
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      activatedSkillDirs: new Set(),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);
    this.lastUsedId = restoredWorkspace.id;

    return restoredWorkspace;
  }

  /**
   * Resolve the workspace a `js` call should run in.
   *
   * Clients lose opaque ids: a model may echo a corrupted id, or none at all.
   * - an exact id always wins;
   * - an absolute / `~` path opens (or reuses) that directory;
   * - an empty reference reuses the most recently used workspace;
   * - an unknown id fails with the current candidates and an explicit recovery hint.
   */
  async resolveWorkspace(reference?: string): Promise<Workspace> {
    const ref = reference?.trim();
    if (!ref) return this.latestWorkspace();

    try {
      return this.getWorkspace(ref);
    } catch (error) {
      if (!isPathReference(ref)) throw this.unknownWorkspaceError(ref, error);
    }

    const info = await stat(expandHomePath(ref)).catch(() => undefined);
    if (!info?.isDirectory()) throw this.unknownWorkspaceError(ref);

    // A model may pass the root path instead of the id on every call; re-opening a known root
    // costs a git scan per request, so answer from the registry first.
    const target = resolve(expandHomePath(ref));
    for (const workspace of this.workspaces.values()) {
      if (workspace.root === target) {
        this.lastUsedId = workspace.id;
        this.store?.touchSession(workspace.id);
        return workspace;
      }
    }

    const context = await this.openWorkspace({ path: ref });
    return context.workspace;
  }

  /** Most recently used workspace, restored from disk when the process restarted. */
  latestWorkspace(): Workspace {
    if (this.lastUsedId) {
      const workspace = this.workspaces.get(this.lastUsedId);
      if (workspace) {
        this.store?.touchSession(workspace.id);
        return workspace;
      }
      try {
        return this.getWorkspace(this.lastUsedId);
      } catch {
        // Stored root is no longer accessible; fall through to other sessions.
      }
    }

    for (const session of this.store?.listRecentSessions(20) ?? []) {
      try {
        return this.getWorkspace(session.id);
      } catch {
        // Skip sessions whose root is not allowed any more.
      }
    }

    const fallback = [...this.workspaces.values()].at(-1);
    if (fallback) return fallback;

    throw new Error("还没有打开的工作区。先调用 open_workspace 打开一个目录。");
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const id = workspaceIdFor(input.root, input.mode);
    const existing = this.workspaces.get(id);
    if (existing) {
      this.store?.createSession({
        id: existing.id,
        root: existing.root,
        mode: existing.mode,
        sourceRoot: existing.sourceRoot,
        baseRef: existing.worktree?.baseRef,
        baseSha: existing.worktree?.baseSha,
        managed: existing.worktree?.managed,
      });
      this.lastUsedId = existing.id;
      const agentsFiles = await this.loadInitialAgentsFiles(existing.root);
      const availableAgentsFiles = await this.findAvailableAgentsFiles(existing.root, agentsFiles);
      return { workspace: existing, agentsFiles, availableAgentsFiles };
    }

    const workspace: Workspace = {
      id,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    this.lastUsedId = workspace.id;
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return { workspace, agentsFiles, availableAgentsFiles };
  }

  private unknownWorkspaceError(reference: string, cause?: unknown): Error {
    const candidates: Array<{ id: string; root: string }> = [];
    const seen = new Set<string>();
    const collect = (id: string, root: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      candidates.push({ id, root });
    };

    for (const session of this.store?.listRecentSessions(10) ?? []) collect(session.id, session.root);
    for (const workspace of this.workspaces.values()) collect(workspace.id, workspace.root);

    const lines = [`Unknown workspaceId: ${reference}。`];
    if (candidates.length > 0) {
      lines.push("当前可用的工作区：");
      for (const candidate of candidates.slice(0, 5)) {
        lines.push(`- ${candidate.id}  ${candidate.root}`);
      }
      lines.push(
        `不要重新 open_workspace：省略 workspaceId 即可复用最近使用的 ${candidates[0].id}，或直接传入项目根目录。`,
      );
    } else {
      lines.push("当前没有打开的工作区。先调用 open_workspace 打开一个目录。");
    }

    const error = new Error(lines.join("\n"), cause === undefined ? undefined : { cause });
    error.name = "UnknownWorkspaceIdError";
    return error;
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
    const loadedFiles: LoadedAgentsFile[] = [];

    const seen = new Set<string>();
    for (const directory of [agentDir, root]) {
      const candidatePath = await firstContextFilePath(directory);
      if (!candidatePath) continue;
      const path = resolve(candidatePath);
      if (!isInitialAgentsFilePath(path, root, agentDir)) continue;

      const content = await readResolvedContextFile(
        path,
        resolvedRoot,
        resolvedAgentDir,
      );
      if (content === undefined) continue;

      const resolvedPath = (await tryRealpath(path)) ?? path;
      const key = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
      if (seen.has(key)) continue;
      seen.add(key);
      loadedFiles.push({ path, content });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const gitPaths = await findGitContextFiles(root);

    if (gitPaths) {
      return gitPaths
        .map((path) => resolve(path))
        .filter((path) => !loadedPaths.has(path))
        .map((path) => ({ path }))
        .sort((a, b) => a.path.localeCompare(b.path));
    }

    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<Stats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

/**
 * Stable per-directory workspace id. Reopening the same directory always yields
 * the same handle, so a client can recover by re-running open_workspace instead
 * of chasing a fresh opaque UUID every turn.
 */
export function workspaceIdFor(root: string, mode: WorkspaceMode): string {
  const digest = createHash("sha256").update(`${mode}\0${root}`).digest("hex");
  return `ws_${digest.slice(0, 12)}`;
}

function isPathReference(reference: string): boolean {
  return (
    reference === "~" ||
    reference.startsWith("~/") ||
    reference.startsWith("~\\") ||
    reference.startsWith("/") ||
    reference.startsWith("./") ||
    reference.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(reference)
  );
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  ".localspace",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "coverage",
  "target",
]);
const MAX_FALLBACK_CONTEXT_SCAN_ENTRIES = 50_000;
const GIT_CONTEXT_DISCOVERY_TIMEOUT_MS = 5_000;

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isInitialAgentsFilePath(path: string, root: string, agentDir: string): boolean {
  if (isPathInsideRoot(path, agentDir)) return true;
  return isPathInsideRoot(path, root) && dirname(path) === root;
}

async function readResolvedContextFile(
  path: string,
  root: string,
  agentDir: string,
): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);
    if (!isInitialAgentsFilePath(resolvedPath, root, agentDir)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch {
    return undefined;
  }
}

async function firstContextFilePath(
  directory: string,
): Promise<string | undefined> {
  for (const name of CONTEXT_FILE_CANDIDATES) {
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (info.isFile() || info.isSymbolicLink()) return path;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") continue;
    }
  }
  return undefined;
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
  state: { entries: number; truncated: boolean } = { entries: 0, truncated: false },
): Promise<void> {
  if (state.truncated) return;

  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    state.entries += 1;
    if (state.entries > MAX_FALLBACK_CONTEXT_SCAN_ENTRIES) {
      state.truncated = true;
      return;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit, state);
      }
      continue;
    }

    await visit(path, entry);
  }
}

async function findGitContextFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout: topLevelOutput } = await execFileAsync(
      resolveGitExecutable(),
      ["-C", root, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: GIT_CONTEXT_DISCOVERY_TIMEOUT_MS,
      },
    );
    const gitRoot = resolve(String(topLevelOutput).trim());
    const workspacePrefix = relative(gitRoot, root).split(sep).join("/");

    if (
      workspacePrefix === ".." ||
      workspacePrefix.startsWith("../") ||
      workspacePrefix.includes("/../")
    ) {
      return undefined;
    }

    const prefix = workspacePrefix ? `${workspacePrefix}/` : "";
    const pathspecs = [...CONTEXT_FILE_NAMES].flatMap((name) => [
      `${prefix}${name}`,
      `:(glob)${prefix}**/${name}`,
    ]);
    const { stdout } = await execFileAsync(
      resolveGitExecutable(),
      [
        "-C",
        gitRoot,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--full-name",
        "--",
        ...pathspecs,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: GIT_CONTEXT_DISCOVERY_TIMEOUT_MS,
      },
    );

    const paths = new Set<string>();
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line) continue;
      const absolutePath = resolve(gitRoot, line);
      if (!isPathInsideRoot(absolutePath, root)) continue;
      if (!CONTEXT_FILE_NAMES.has(basename(absolutePath))) continue;
      paths.add(absolutePath);
    }

    return [...paths];
  } catch {
    return undefined;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

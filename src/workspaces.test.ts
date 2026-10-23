import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveGitExecutable } from "./process-platform.js";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { ensureCheckoutWorkspaceRoot, WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-workspace-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "localspace-workspace-outside-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    LOCALSPACE_ALLOWED_ROOTS: root,
    LOCALSPACE_WORKTREE_ROOT: join(root, ".localspace", "worktrees"),
    LOCALSPACE_AGENT_DIR: agentDir,
    LOCALSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles } = await registry.openWorkspace(root);

  assert.equal(workspace.mode, "checkout");
  assert.match(workspace.id, /^ws_[0-9a-f]{12}$/);
  // Reopening the same directory is idempotent: the handle is derived from the root.
  const reopened = await registry.openWorkspace(root);
  assert.equal(reopened.workspace.id, workspace.id);
  assert.equal(reopened.workspace.root, workspace.root);
  // Omitted reference and a directory path both resolve to the same handle.
  assert.equal((await registry.resolveWorkspace()).id, workspace.id);
  assert.equal((await registry.resolveWorkspace(root)).id, workspace.id);
  await assert.rejects(
    () => registry.resolveWorkspace("ws_000000000000"),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(workspace.id) &&
      error.message.includes("省略 workspaceId"),
  );
  assert.throws(
    () => new WorkspaceRegistry(config).latestWorkspace(),
    /还没有打开的工作区/,
  );
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    availableAgentsFiles.map((file) => file.path),
    [join(root, "nested", "AGENTS.md")],
  );

  {
    let mkdirCalls = 0;
    const existingStats = await ensureCheckoutWorkspaceRoot(root, {
      stat: async (path) => {
        assert.equal(path, root);
        return await stat(path);
      },
      mkdir: async () => {
        mkdirCalls += 1;
      },
    });
    assert.equal(existingStats.isDirectory(), true);
    assert.equal(mkdirCalls, 0);
  }

  if (platform() !== "win32") {
    const safeAgentDir = join(root, ".pi", "safe-agent");
    await mkdir(join(safeAgentDir, "instructions"), { recursive: true });
    await writeFile(join(safeAgentDir, "instructions", "AGENTS.md"), "safe linked instructions\n");
    await symlink("instructions/AGENTS.md", join(safeAgentDir, "AGENTS.md"));
    const safeConfig = loadConfig({
      LOCALSPACE_ALLOWED_ROOTS: root,
      LOCALSPACE_WORKTREE_ROOT: join(root, ".localspace", "safe-worktrees"),
      LOCALSPACE_AGENT_DIR: safeAgentDir,
      LOCALSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const safeWorkspace = await new WorkspaceRegistry(safeConfig).openWorkspace(root);
    assert.deepEqual(
      safeWorkspace.agentsFiles.map((file) => file.content),
      ["safe linked instructions\n", "root instructions\n"],
    );

    const unsafeAgentDir = join(root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));
    const unsafeConfig = loadConfig({
      LOCALSPACE_ALLOWED_ROOTS: root,
      LOCALSPACE_WORKTREE_ROOT: join(root, ".localspace", "unsafe-worktrees"),
      LOCALSPACE_AGENT_DIR: unsafeAgentDir,
      LOCALSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(root);
    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await mkdir(join(gitRoot, "nested"));
  await writeFile(join(gitRoot, "nested", "CLAUDE.md"), "nested git instructions\n");
  await writeFile(join(gitRoot, ".gitignore"), ".worktrees/\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "localspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "LocalSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");
  await mkdir(join(gitRoot, "untracked"));
  await writeFile(join(gitRoot, "untracked", "AGENTS.md"), "untracked instructions\n");
  await mkdir(join(gitRoot, ".worktrees", "large", "nested"), { recursive: true });
  await writeFile(
    join(gitRoot, ".worktrees", "large", "nested", "AGENTS.md"),
    "ignored worktree instructions\n",
  );

  const gitWorkspace = await registry.openWorkspace(gitRoot);
  assert.deepEqual(
    gitWorkspace.availableAgentsFiles.map((file) => file.path),
    [
      join(gitRoot, "nested", "CLAUDE.md"),
      join(gitRoot, "untracked", "AGENTS.md"),
    ],
  );

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  // Reopening with the store attached upserts the existing session instead of failing on the primary key.
  const persistentAgain = await persistentRegistry.openWorkspace(root);
  assert.equal(persistentAgain.workspace.id, persistentWorkspace.workspace.id);
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");

  const restoredWorktree = restoredRegistry.getWorkspace(persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);
  secondStore.close();

  {
    // A fresh process restores the most recently used workspace from the store.
    const thirdStore = new SqliteWorkspaceStore(stateDir);
    const thirdRegistry = new WorkspaceRegistry(config, thirdStore);
    assert.equal(thirdRegistry.latestWorkspace().id, persistentWorktree.workspace.id);
    thirdStore.close();
  }

  if (platform() !== "win32") {
    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      LOCALSPACE_ALLOWED_ROOTS: aliasRoot,
      LOCALSPACE_WORKTREE_ROOT: join(aliasRoot, ".localspace", "alias-worktrees"),
      LOCALSPACE_AGENT_DIR: agentDir,
      LOCALSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, join(aliasRoot, "git-project"));

    const aliasCheckout = await new WorkspaceRegistry(aliasConfig).openWorkspace(aliasRoot);
    assert.deepEqual(
      aliasCheckout.agentsFiles.map((file) => file.content),
      ["global instructions\n", "root instructions\n"],
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync(resolveGitExecutable(), args, { cwd, windowsHide: true });
}

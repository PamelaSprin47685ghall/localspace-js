# Configuration Reference

LocalSpace can be configured through `localspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.localspace/config.json
~/.localspace/auth.json
```

Use another config directory with:

```bash
LOCALSPACE_CONFIG_DIR=/path/to/config localspace serve
```

## Commands

```bash
localspace init
localspace serve
localspace doctor
localspace config get
localspace config set publicBaseUrl https://localspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `LOCALSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `LOCALSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `LOCALSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `LOCALSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `LOCALSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.localspace/worktrees`. |
| `LOCALSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/localspace`. |
| `LOCALSPACE_SHELL` | Optional shell executable for `exec_command`, for example `cmd.exe`, `powershell.exe`, `pwsh`, Git Bash, or `wsl.exe`. |
| `LOCALSPACE_TOOL_PACKS` | Optional comma-separated tool packs. Currently accepts only `code-intelligence`; defaults to no packs. |

## MCP 协议与传输

`/mcp` 只有无状态模式（旧的 stateful 模式与 `LOCALSPACE_MCP_TRANSPORT_MODE`、`LOCALSPACE_MCP_SESSION_*`、`LOCALSPACE_MCP_MAX_SESSIONS` 已删除）：

- 2026-07-28 协议（`server/discover` + 逐请求 `_meta` 信封，需带 `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` 头）由 `@modelcontextprotocol/server` 的 `createMcpHandler` 服务；`server/discover` 返回服务端 instructions。
- 2025 时代协议（`initialize` 握手，2024-10-07 … 2025-11-25）每个 POST 新建 server + 无状态 transport，直接回 `application/json`；GET/DELETE 返回 405。
- 客户端断开即中止该请求的 js 程序，并杀掉其 worker 与进程组。
- `LOCALSPACE_TRAFFIC_LOG=0` 关闭完整流量日志；日志含请求头，`authorization`/`cookie` 记为 `[redacted]`。

## Tool Concurrency

LocalSpace applies bounded concurrency before invoking registered tools. The
defaults permit parallel read-only work while preserving deterministic mutation,
Git, and process-session behavior.

| Variable | Default |
| --- | --- |
| `LOCALSPACE_MAX_CONCURRENT_TOOL_CALLS` | `8` |
| `LOCALSPACE_MAX_CONCURRENT_SCANS` | `2` |
| `LOCALSPACE_MAX_CONCURRENT_PROCESSES` | `4` |
| `LOCALSPACE_MAX_WORKSPACE_PROCESSES` | `2` |
| `LOCALSPACE_TOOL_QUEUE_TIMEOUT_MS` | `120000` |

LocalSpace injects the effective values into the MCP server instructions that
the client model receives during initialization. The instructions group the
currently exposed tools by concurrency behavior instead of repeating the same
guidance in every tool description:

- independent shared-read tools may be called in parallel;
- heavy code scans may run concurrently up to the configured scan limit;
- workspace mutations and Git writes should not be intentionally parallelized;
- process-start tools may run concurrently only when their side effects do not
  share generated files, databases, caches, or ports;
- calls targeting the same process session remain sequential;
- `read_many` and `run_checks` are preferred for bounded batch work when those
  tools are available in the configured tool mode.

The tool names in this guidance are generated from the current Tool Catalog and
Tool Mode, and the numeric limits come from the active configuration. This keeps
the model-facing instructions aligned with custom concurrency settings without
inflating every individual tool schema.

The scheduler uses the concurrency class stored in `src/tool-catalog.ts`:

- shared reads may run together for the same workspace;
- heavy TypeScript/JavaScript scans also consume the global scan limit;
- LocalSpace file mutations take an exclusive workspace lock;
- Git writes take a Git-root mutex before the exclusive workspace lock;
- `write_stdin` calls for the same process session are serialized;
- worktree creation uses a global exclusive execution lock;
- process permits remain held until the child process exits, not merely until
  `exec_command` returns a session ID.

`exec_command` remains an open-world command surface. Concurrency limits prevent
unbounded process creation but cannot prove that two arbitrary commands do not
write the same generated file, database, cache, or port. Use conservative
workspace process limits and only run independent commands in parallel.

Queue waits are bounded by `LOCALSPACE_TOOL_QUEUE_TIMEOUT_MS`. Tool activity and
process results expose `queuedMs`; a timeout fails the waiting call without
executing its operation.

## Workspace Policy

A project may add a restrictive policy at:

```text
.localspace/policy.json
```

Policy version 1 supports:

```json
{
  "version": 1,
  "readOnlyPaths": ["src/generated", "package-lock.json"],
  "deniedCommandPatterns": ["npm publish*", "git push*--force*"],
  "allowedPackageScripts": ["test", "typecheck"],
  "maxReadManyFiles": 5,
  "allowCommands": true,
  "allowPty": false,
  "requireApprovalTools": ["exec_command", "run_checks"]
}
```

Every field is restrictive:

- `readOnlyPaths` blocks LocalSpace write, edit, patch, Git staging, and commit
  operations that target the listed workspace-relative paths;
- `deniedCommandPatterns` uses bounded `*` and `?` wildcard matching against the
  complete command string; it does not execute project-provided regular
  expressions;
- `allowedPackageScripts` limits `run_checks` to the named `package.json`
  scripts; omitting the field leaves the server's existing script behavior
  unchanged, while an empty array denies every package script. When a package
  manager would invoke `pre<name>` or `post<name>`, those lifecycle script names
  must also appear in the allowlist;
- `maxReadManyFiles` lowers the server maximum of 20 files per `read_many` call;
- `allowCommands: false` disables arbitrary shell commands;
- `allowPty: false` disables pseudo-terminal allocation;
- `requireApprovalTools` can require the existing one-time approval flow for
  every `exec_command` or `run_checks` call, even when the command's built-in
  risk analysis would otherwise be below `danger`.

The policy cannot enable a tool, expand an allowed root, weaken sensitive-path
protection, increase server limits, or bypass command approval. Unknown fields,
invalid paths, unsupported approval tool names, malformed JSON, and oversized
policy files cause mutations and commands to fail closed. Read-only inspection
remains available so the problem can be diagnosed.

On first successful load LocalSpace stores a policy anchor under the configured
state directory. Later project-file changes are merged monotonically with that
anchor: read-only paths and denied commands can only accumulate, script
allowlists can only shrink, limits can only decrease, and disabled capabilities
remain disabled. Deleting or relaxing the project file therefore does not relax
an already anchored session, including after a normal service restart. Policy
relaxation is an explicit out-of-band administrative action and is not exposed
through MCP tools.

Managed worktrees inherit the source checkout's policy. The policy file itself
is a protected sensitive path and cannot be changed through LocalSpace write,
edit, patch, or Git staging tools.

`readOnlyPaths` constrains LocalSpace's dedicated mutation and Git tools. An
arbitrary shell command still runs with the operating-system permissions of the
LocalSpace process. Projects that require path-level enforcement against shell
commands should set `allowCommands: false`, or combine a narrow command deny
policy with trusted package scripts.

`git_add` uses literal Git pathspecs and accepts explicit file paths only.
Directory staging is rejected so a broad path cannot silently include a
read-only or sensitive descendant. Deleted tracked files remain stageable by
their explicit former path. `git_commit` independently rechecks every staged
source and destination path, including both sides of detected renames.

Package-check safety analysis includes the selected script plus existing
`pre<name>` and `post<name>` lifecycle scripts. A dangerous lifecycle hook
therefore requires the same one-time approval as a dangerous main script.

## Deterministic Automation and Commit Preflight

LocalSpace includes internal deterministic review rules. These are not arbitrary
project hooks and do not execute repository-provided shell commands
automatically.

The current rules inspect changed paths and recent LocalSpace audit evidence:

- source and common build-config changes suggest running the project's formatter
  when one exists;
- source or package changes require successful validation after the latest
  detected change, otherwise validation freshness is `stale` or `unknown`;
- `package.json` and supported lockfile changes require a successful package
  dry-run recorded after the change;
- environment, credential, token, private-key, authentication, and workspace
  policy-like paths require explicit review;
- staged changes always recommend inspecting the exact staged diff.

`review_checklist`, `task_summary`, and `validation_summary` return the same
structured `automation` assessment. Successful `exec_command` and `run_checks`
events record a non-sensitive validation category in audit metadata, so
freshness can still be evaluated when command preview logging is disabled.

When `git_commit` finds an unmet `required` recommendation, it does not commit.
It returns a one-time approval token bound to:

- the exact commit message;
- the current Workspace revision;
- all staged source and destination paths;
- the current required recommendation set and validation state.

Changing staged or unstaged Workspace content invalidates that token. Retrying
the unchanged commit with the returned token records explicit approval and
allows the commit. Approval is an intentional override, not evidence that the
recommended validation actually passed.

Documentation-only changes normally do not require validation approval. Source
changes with current successful validation can commit without an extra token.
Package dry-run evidence only satisfies the package rule when it was recorded
after the package metadata change.

Validation freshness is conservative. Deleted paths, unavailable timestamps,
service restarts, or missing in-memory audit evidence can produce `unknown` and
therefore require validation or explicit approval. LocalSpace never infers that
an external command passed merely because files appear unchanged.

There is no support for arbitrary `.localspace` shell hooks. Formatting,
testing, packaging, deployment, and release commands remain explicit
`exec_command` or `run_checks` operations subject to policy and approval.

## OAuth

LocalSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `LOCALSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `LOCALSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `LOCALSPACE_OAUTH_SCOPES` | `localspace` |
| `LOCALSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

LocalSpace is designed around `hybrid` as the default and recommended tool
surface. It keeps the complete ChatGPT coding loop available: safe workspace
inspection, code navigation, patching, process tools, Git helpers, and workflow
Skills plus a bounded activity summary.

`LOCALSPACE_TOOL_MODE` remains available for legacy compatibility and advanced
experiments, but most users should leave it unset.

| Value | Behavior |
| --- | --- |
| `hybrid` | Default. Exposes `open_workspace`, `doctor`, `workspace_info`, `entrypoints`, `read`, `read_many`, `code_map`, `project_map`, `symbols`, `imports`, `references`, `apply_patch`, `exec_command`, `run_checks`, `write_stdin`, `changes`, `git_*`, dedicated `grep`/`glob`/`ls`, and the focused completion helpers `next_steps`, `validation_summary`, `final_report`, and `handoff_summary`. |
| `codex` | Experimental compatibility. Exposes `open_workspace`, `doctor`, `workspace_info`, `entrypoints`, `read`, `read_many`, `apply_patch`, `exec_command`, `run_checks`, `write_stdin`, `changes`, and `git_*` tools. Existing mutation and shell tools are hidden. |
| `full` | Legacy compatibility. Exposes the minimal tools plus dedicated `doctor`, `workspace_info`, `entrypoints`, `code_map`, `project_map`, `symbols`, `imports`, `references`, `grep`, `glob`, `ls`, `changes`, and `git_*` tools. |
| `minimal` | Legacy compatibility. Exposes `open_workspace`, `doctor`, `workspace_info`, `entrypoints`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |

The exact generated tool lists, including compatibility helpers and Widget
overlays, are maintained in [`tool-surfaces.md`](tool-surfaces.md).

### Optional code-intelligence pack

Set:

```bash
LOCALSPACE_TOOL_PACKS="code-intelligence" node dist/cli.js serve
```

This adds four read-only tools to every tool mode:

- `diagnostics`
- `definition`
- `implementations`
- `rename_preview`

The pack is limited to TypeScript and JavaScript source extensions. It discovers
the nearest `tsconfig.json` or `jsconfig.json`, supports path aliases, recursively
loads workspace-local project references for interactive navigation, and keeps
a process-level Language Service cache with an LRU limit of 32 projects. Source snapshots invalidate when file
metadata changes; project configuration and root-file-list changes rebuild the
cached project.

`rename_preview` only returns bounded edit locations and replacement text. It
does not write files. Definitions, implementations, and rename edits outside the
opened workspace are omitted. A configured project is bounded to 5,000 source
files, diagnostics default to 100 results, and location tools default to 200.

TypeScript is an optional npm dependency. Normal npm installation includes it;
installations using `--omit=optional` can still start and use the core LocalSpace
surface. If the pack is enabled without TypeScript installed, its tools return
`supported: false` with an installation message instead of failing server startup.

For solution-style projects, the pack preserves project-reference metadata but
combines workspace-local referenced source files into the interactive Language
Service so navigation works before `tsc -b` output exists. This is an editor
navigation model, not a replacement for the exact build semantics of `tsc -b`.

`LOCALSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`LOCALSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `LOCALSPACE_TOOL_MODE`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

`project_map` renders a compact directory tree for an open workspace. It defaults
to `depth: 3`, `maxEntries: 300`, `includeFiles: true`, and `showHidden: false`,
and skips large/generated folders such as `.git`, `node_modules`, `dist`,
`build`, `.next`, `.turbo`, `.cache`, `coverage`, and `.localspace`.

`symbols` scans TypeScript and JavaScript files for top-level declarations and
class methods. It reports file paths, line numbers, symbol kinds, symbol names,
and export status. It supports name and kind filters plus result/file limits.

`imports` scans TypeScript and JavaScript files for imports, dynamic imports,
re-exports, and exported declarations. `references` scans TypeScript and
JavaScript AST identifiers to find usage sites for a symbol name.

`doctor` reports LocalSpace configuration and runtime diagnostics, including
tool mode, widget mode, roots, state directories, Node/npm/Git availability, and
configured shell health. Pass a `workspaceId` to include workspace diagnostics.

`workspace_info` reports workspace root/mode, Git branch/status/recent commits,
and package metadata/scripts for an open workspace.

`entrypoints` reports package entrypoint fields, scripts, likely source entry
files, suggested verification commands, and important config/orientation files.

`code_map` aggregates entrypoints, a compact project tree, exported symbols, and
import/export relationships for a bounded project overview.

`read` reads one workspace file or an authorized Skill file. Text files are
returned as bounded line ranges. PNG, JPEG, GIF, and WebP files identified from
their file bytes—not merely their extension—are returned as MCP image content
when they are no larger than 5 MB. `offset` and `limit` apply only to text files.
SVG is not emitted as image content, and an oversized image returns a bounded
text notice instead of an inline image payload.

`read_many` reads 1–20 already-known text files in input order using bounded
internal concurrency. It returns partial results when individual files fail,
limits combined returned text to 50,000 characters by default (200,000 max),
and preserves per-file truncation metadata. Images are intentionally rejected by
`read_many`; use `read` for image content. Skill supporting files cannot be
unlocked by placing a Skill's `SKILL.md` and its supporting file in the same
batch—read the advertised `SKILL.md` first, then issue a later read.

The code navigation tools return plain text for human-readable MCP hosts and
structured content for model or UI consumers. `symbols`, `imports`,
`references`, `entrypoints`, and `code_map` expose typed arrays and summaries in
their `structuredContent` payloads while preserving the `result` text field.

Workspace and Git tools follow the same pattern. `doctor`, `workspace_info`,
`changes`, and `git_*` tools preserve text output and add structured summaries
for health checks, branch status, grouped changes, commits, and truncation flags.
See [`structured-content.md`](structured-content.md) for the field summary.

`exec_command` blocks `danger` risk commands before execution and returns a
one-time `approvalToken`. Retry the exact same command with `approvalToken` only
after the user explicitly confirms. Tokens are scoped to the same workspace,
working directory, command, and risk level.

`run_checks` accepts 1–8 exact script names declared in the workspace
`package.json`. It resolves the package manager from `packageManager` or lock
files, validates every script before starting any process, and runs checks with
default concurrency 2 (maximum 4). `failFast: true` stops starting queued checks
after the first failure; already-running checks finish. It is not an arbitrary
command batcher—custom commands continue to use `exec_command`.

Dangerous package scripts are blocked as a group. LocalSpace returns one
approval token per dangerous script; retry the same check list with matching
`approvals[]` only after explicit user confirmation. Approval consumption is
atomic, so a missing or mismatched token does not consume otherwise valid
tokens.

Long-running check groups return a negative session ID. Use `write_stdin` to
poll or send Ctrl-C. Check-group sessions reject arbitrary stdin and terminal
resize. Results include per-check status/output, aggregate counts, queue time,
and workspace revision markers so a completed check can be identified as stale
when the Git-visible workspace changed during execution. The revision includes
HEAD, staged and unstaged changes, and untracked file contents; Git-ignored
cache or build output is intentionally outside that stale-result check.

Write-like tools also classify sensitive paths using generic rules rather than
hard-coded personal paths. Workspace-local Git configuration/hooks, real `.env`
files, authentication files, and secret/token/private-key-like data files return
a one-time approval token before mutation or staging. The token is bound to the
exact operation and unchanged Workspace revision. `.env.example`/sample/template
files and source names such as `tokenizer.ts` are not treated as credentials.
`.localspace/policy.json`, LocalSpace state/agent/worktree directories,
home-directory roots, and platform system directories remain permanently
protected and cannot be opened by an approval token.

LocalSpace keeps bounded in-memory activity and MCP request metric rings for
`session_summary`. They record recent read, search, navigation, process,
mutation, Git, workflow, and diagnostic tool calls plus request phase timings
without persisting normal read activity. The ring capacity uses
`LOCALSPACE_AUDIT_MAX_MEMORY_EVENTS` and is lost when the service restarts.

Request metrics split client-observed MCP handling into authentication, MCP
server construction, transport connection, transport handling, cleanup, and
total server time. `transportHandle` includes SDK dispatch, tool execution, and
response serialization because those phases are not independently exposed by
the current MCP SDK boundary. Request and response byte counts use available
HTTP `Content-Length` headers and may be zero when a transport streams without
that header.

Tool activity metrics separately measure each registered tool callback. They
record execution time and the serialized UTF-8 byte lengths of returned
`content` and `structuredContent`, but never retain those payloads solely for
metrics. This makes it possible to identify high-volume tools without adding
file contents, command output, or structured payloads to the activity ring.

Durable audit logging is enabled by default for security-relevant events such as
file mutations, shell commands, Git writes, approvals, and blocked actions. It
appends JSONL records to `LOCALSPACE_AUDIT_LOG_PATH`, defaulting to `audit.jsonl`
under the LocalSpace state directory. `LOCALSPACE_AUDIT_LOG=0` disables durable
JSONL audit persistence; the bounded in-memory activity summary remains
available.

Workflow helper tools are read-only. The default `hybrid` surface exposes the
focused completion set: `next_steps`, `validation_summary`, `final_report`, and
`handoff_summary`. The legacy `minimal` and `full` surfaces additionally expose
`validate_plan`, `review_checklist`, and `task_summary` for compatibility. The
experimental `codex` surface exposes none of these helpers and instead relies on
`session_summary`, core Git/process tools, and progressively loaded Skills.
Server instructions are generated from the active tool catalog and do not
reference unavailable helpers.

`changes` renders current Git changes as plain text. It supports `summary`,
`stat`, and `patch` modes, can inspect staged changes with `staged: true`, and
does not require `LOCALSPACE_WIDGETS=changes`.

Dedicated Git tools are exposed in `full`, `codex`, and `hybrid` modes:

- `git_status`
- `git_diff`
- `git_add`
- `git_commit`
- `git_log`

They use fixed `git` arguments through `execFile` and do not use `LOCALSPACE_SHELL`.
`git_commit` should only be used when the user asks to commit.

## Shell Selection

By default, `exec_command` uses `cmd.exe` on Windows and a POSIX shell on Linux
or macOS. Set `LOCALSPACE_SHELL` to force a specific shell:

```bash
LOCALSPACE_SHELL="pwsh" localspace serve
LOCALSPACE_SHELL="C:/Program Files/Git/bin/bash.exe" localspace serve
LOCALSPACE_SHELL="wsl.exe" localspace serve
```

LocalSpace automatically chooses shell flags for common shells: `cmd`,
PowerShell, `pwsh`, POSIX shells, Git Bash, and WSL.

`exec_command` also returns non-blocking command safety warnings for patterns
that commonly mutate files, Git history, remotes, permissions, deployments, or
system-level settings. The command still runs; the warning is included in the
tool response and structured output so MCP clients and models can surface it.

## Widgets

`LOCALSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `changes` | Default. Enables the aggregate `show_changes` tool and attaches widget UI only to `open_workspace` and `show_changes`. |
| `full` | Attaches widget UI to exposed workspace, file, edit, and shell tools. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `LOCALSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `LOCALSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `LOCALSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

LocalSpace ships built-in workflow skills. They are loaded from the package and
advertised by `open_workspace` alongside user/project skills:

- `localspace-code-editing`
- `localspace-code-navigation`
- `localspace-debugging`
- `localspace-code-review`
- `localspace-refactoring`
- `localspace-validation`
- `localspace-git-review`
- `localspace-release`
- `localspace-handoff`

To keep the initial workspace response bounded, `open_workspace` returns at
most 12 full name/description/path records: up to 8 project skills plus four
core LocalSpace workflow skills when available. Unused detailed slots may be
filled by other non-project skills. All remaining entries are returned in a
compact `skillIndex`.
The structured response includes `skillsTotal`, `skillsReturned`,
`skillsTruncated`, and `recommendedSkills` so clients can distinguish the full
set from the detailed subset.

Built-in skills provide progressive disclosure for workflow guidance. The MCP
tool surface remains `hybrid`; skills do not hide or reveal tools dynamically.
They tell the model which existing tools to combine for a task and when to run
validation, review changes, or produce a handoff.

The debugging, code-review, and refactoring skills are task-specific workflow
guides. They reuse the existing `hybrid` tools and do not add a hidden agent,
background execution loop, or dynamic tool registration.

LocalSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`

It also keeps compatibility with:

- `LOCALSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `LOCALSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `LOCALSPACE_SKILL_PATHS` when needed.

Example:

```bash
LOCALSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
localspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `LOCALSPACE_LOG_LEVEL` | `info` |
| `LOCALSPACE_LOG_FORMAT` | `json` |
| `LOCALSPACE_LOG_REQUESTS` | `1` |
| `LOCALSPACE_LOG_ASSETS` | `0` |
| `LOCALSPACE_LOG_TOOL_CALLS` | `1` |
| `LOCALSPACE_LOG_SHELL_COMMANDS` | `0` |
| `LOCALSPACE_TRUST_PROXY` | `0` |

`LOCALSPACE_TRUST_PROXY` (or `trustProxy` in `config.json`) sets Express `trust proxy`.
`1`/`true` means `loopback`: trust only a reverse proxy or tunnel client (frpc, cloudflared,
nginx) on this machine, so the real client IP comes from its `X-Forwarded-For`. Use
`hops:N` for N proxy hops, or an explicit list such as `loopback,10.0.0.0/8`. Never
trust every hop: that lets anyone spoof `X-Forwarded-For` and bypass rate limits.

Set `LOCALSPACE_LOG_FORMAT=pretty` for local debugging.

Set `LOCALSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
LOCALSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
LOCALSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
LOCALSPACE_PUBLIC_BASE_URL="https://localspace.example.com" \
LOCALSPACE_WORKTREE_ROOT="$HOME/.localspace/worktrees" \
LOCALSPACE_SHELL="pwsh" \
LOCALSPACE_TOOL_MODE="hybrid" \
LOCALSPACE_WIDGETS="changes" \
localspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { AuditLogManager } from "../audit-log.js";
import type { ToolActivityLogManager } from "../activity-log.js";
import { API_BRIEF, GUIDELINE_MOTTO, GUIDELINE_TEXT } from "./guideline.js";
import { runProgram } from "./runner.js";
import { globalParkTable } from "./park.js";
import { appendPairHints, composePairHints } from "./pair-hint.js";
import { observeIntentBudget } from "./request-window.js";

export interface JsSurfaceDeps {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  auditLog: AuditLogManager;
  activityLog: ToolActivityLogManager;
  configDir: string;
}

export function registerJsSurface(server: McpServer, deps: JsSurfaceDeps): void {
  const { config, workspaces, auditLog, configDir } = deps;

  server.registerTool(
    "open_workspace",
    {
      title: "打开工作区",
      description:
        "打开允许根内的本地项目目录或托管 worktree，返回 workspaceId、总纲与 API 速查。" +
        "workspaceId 由目录决定且稳定：同一文件夹重复打开返回同一个 id。",
      inputSchema: z.object({
        path: z.string().describe("绝对路径，或 ~/… 形式的家目录路径。"),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe("默认 checkout。worktree 创建隔离的托管 Git worktree。"),
        baseRef: z.string().optional().describe("worktree 的基础 Git ref，默认 HEAD。"),
      }),
      outputSchema: z.object({
        servedAt: z.string().describe("本次回复的 UTC 时间（ISO 8601）。"),
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        guideline: z.string(),
        apiBrief: z.string(),
        agentsFiles: z.array(z.object({ path: z.string(), content: z.string() })),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      try {
        const context = await workspaces.openWorkspace({
          path,
          mode: mode ?? "checkout",
          baseRef,
        });
        const servedAt = new Date().toISOString();
        const body = {
          servedAt,
          workspaceId: context.workspace.id,
          root: context.workspace.root,
          mode: context.workspace.mode,
          sourceRoot: context.workspace.sourceRoot,
          guideline: GUIDELINE_TEXT,
          apiBrief: API_BRIEF,
          agentsFiles: context.agentsFiles.map((f) => ({
            path: f.path,
            content: f.content,
          })),
        };
        const text = [
          `已打开工作区 ${body.workspaceId}`,
          `根目录：${body.root}`,
          "",
          "—— 总纲 ——",
          GUIDELINE_TEXT,
          "",
          "—— API 速查 ——",
          API_BRIEF,
        ].join("\n");
        auditLog.record({
          tool: "open_workspace",
          workspaceId: body.workspaceId,
          action: "open",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        const hints = composePairHints({
          now: servedAt,
          workspaceId: body.workspaceId,
          root: body.root,
          ...(await gitHint(body.root)),
          parked: globalParkTable.list(body.workspaceId),
          restart: workspaces.takeRestoredNotice(body.workspaceId),
          motto: GUIDELINE_MOTTO,
        });
        return {
          content: [{ type: "text" as const, text: appendPairHints(text, hints) }],
          structuredContent: body,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        auditLog.record({
          tool: "open_workspace",
          action: "open",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `打开工作区失败：${message}` }],
        };
      }
    },
  );

  server.registerTool(
    "js",
    {
      title: "JS 编程面",
      description:
        "在工作区运行一段平铺的异步 JavaScript 程序。必填输入为 program 和 intent（本次请求的意图），workspaceId 可省略。" +
        "省略时使用最近使用的工作区；也可直接传入项目根目录路径。不要为了拿新 id 重新 open_workspace。" +
        "全部原语均为 this 成员：this.cat/stat/ls/search/findRelated/where/whereAll/write/mkdir/mv/rm/call/park，" +
        "以及 this.signal(sig) 与 this.send(input)。" +
        "顶层 intent 的 UTF-8 字节数 × 50ms 是整次请求的统一等待时限：每 20 字节 1 秒，单次封顶 30 秒（600 字节）。this.call(command) 和 this.unpark(handle,value?) 共用剩余时间，恢复目标不会新建预算；客户端断开后程序继续跑，现场留在 parked 列表；写入立即落盘；危险操作与 where 歧义会 park。" +
        "互不相干的任务可在同一轮并行调用多个 js。",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .nullish()
          .describe("open_workspace 返回的稳定标识，或项目根目录路径。省略则复用最近使用的工作区。"),
        program: z.string().min(1).describe("平铺的异步 JavaScript 程序体，可直接 await 顶层。"),
        intent: z.string().min(1).describe("本次请求想达成什么。换算：每 20 个 UTF-8 字节 = 1 秒，单次请求最多 30 秒（600 字节，写更长也按 30 秒封顶）。这个截止时间被整次请求及其全部 call、unpark 共用，程序内不能续期；客户端断开时程序继续在后台跑。"),
      }),
      outputSchema: z.object({
        servedAt: z.string().describe("本次回复的 UTC 时间（ISO 8601）。"),
        status: z.enum(["done", "parked", "failed", "abandoned"]),
        value: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
        parked: z
          .object({
            handle: z.string(),
            kind: z.enum(["yield", "where", "park", "confirm"]),
            payload: z.unknown(),
            expiresAt: z.string(),
            elapsedMs: z.number(),
          })
          .optional(),
        written: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ workspaceId, program, intent }, ctx) => {
      const startedAt = performance.now();
      let resolvedId: string | undefined = workspaceId ?? undefined;
      try {
        const workspace = await workspaces.resolveWorkspace(workspaceId ?? undefined);
        resolvedId = workspace.id;
        const result = await runProgram({
          workspaceId: workspace.id,
          root: workspace.root,
          allowedRoots: config.allowedRoots,
          configDir,
          stateDir: config.stateDir,
          program,
          intent,
          signal: ctx.mcpReq.signal,
        });

        const servedAt = new Date().toISOString();
        const summary = formatJsResult(result);
        const risk =
          result.status === "parked" && result.parked?.kind === "confirm"
            ? {
                op: String((result.parked.payload as { danger?: string })?.danger ?? "confirm"),
                target: String((result.parked.payload as { target?: string })?.target ?? ""),
                allowed: false,
              }
            : undefined;

        const admittedBudget = observeIntentBudget(intent);
        const hints = composePairHints({
          now: servedAt,
          workspaceId: workspace.id,
          root: workspace.root,
          ...(await gitHint(workspace.root)),
          parked: globalParkTable.list(workspace.id),
          yieldPark: result.status === "parked" && result.parked?.kind === "yield",
          budget: { bytes: admittedBudget.bytes, ms: admittedBudget.budgetMs },
          restart: workspaces.takeRestoredNotice(workspace.id),
          risk,
          motto: GUIDELINE_MOTTO,
        });

        auditLog.record({
          tool: "js",
          workspaceId: workspace.id,
          action: result.status,
          success: result.status === "done" || result.status === "parked",
          durationMs: Math.round(performance.now() - startedAt),
          error: result.error?.message,
        });

        return {
          isError: result.status === "failed",
          content: [{ type: "text" as const, text: appendPairHints(summary, hints) }],
          structuredContent: {
            servedAt,
            status: result.status,
            value: result.value,
            error: result.error,
            parked: result.parked
              ? {
                  handle: result.parked.handle,
                  kind: result.parked.kind,
                  payload: result.parked.payload,
                  expiresAt: result.parked.expiresAt,
                  elapsedMs: result.parked.elapsedMs,
                }
              : undefined,
            written: result.written,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        auditLog.record({
          tool: "js",
          workspaceId: resolvedId,
          action: "error",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `js 执行失败：${message}` }],
        };
      }
    },
  );
}

function formatJsResult(result: {
  status: string;
  value?: unknown;
  error?: { code: string; message: string };
  parked?: { handle: string; kind: string; payload: unknown; expiresAt: string; elapsedMs: number };
  written: string[];
}): string {
  const lines = [`status: ${result.status}`];
  if (result.written.length) lines.push(`written: ${result.written.join(", ")}`);
  if (result.error) lines.push(`error: ${result.error.code}: ${result.error.message}`);
  if (result.parked) {
    lines.push(`parked.handle: ${result.parked.handle}`);
    lines.push(`parked.kind: ${result.parked.kind}`);
    lines.push(`parked.expiresAt: ${result.parked.expiresAt}`);
    lines.push(`parked.payload: ${JSON.stringify(result.parked.payload, null, 2)}`);
  }
  if (result.status === "done") lines.push(`value: ${JSON.stringify(result.value, null, 2)}`);
  return lines.join("\n");
}

interface GitHint {
  branch?: string;
  git?: { staged: number; unstaged: number; untracked: number; dirty: boolean };
}

const execFileAsync = promisify(execFile);
const GIT_HINT_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;
const gitHints = new Map<string, { at: number; hint: Promise<GitHint> }>();

/** Hints are advisory: async + cached so `git status` never blocks the event loop for other clients. */
function gitHint(root: string): Promise<GitHint> {
  const cached = gitHints.get(root);
  if (cached && Date.now() - cached.at < GIT_HINT_TTL_MS) return cached.hint;
  const hint = readGitHint(root).catch(() => ({}));
  gitHints.set(root, { at: Date.now(), hint });
  if (gitHints.size > 64) {
    for (const [key, entry] of gitHints) {
      if (Date.now() - entry.at >= GIT_HINT_TTL_MS) gitHints.delete(key);
    }
  }
  return hint;
}

async function readGitHint(root: string): Promise<GitHint> {
  const [branch, status] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).then((r) => r.stdout.trim() || undefined).catch(() => undefined),
    execFileAsync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }).then((r) => countChanges(r.stdout)).catch(() => undefined),
  ]);
  return { branch, git: status };
}

function countChanges(output: string): GitHint["git"] {
  const lines = output.split("\n").filter(Boolean);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith("??")) untracked += 1;
    else {
      if (line[0] && line[0] !== " ") staged += 1;
      if (line[1] && line[1] !== " ") unstaged += 1;
    }
  }
  return { staged, unstaged, untracked, dirty: lines.length > 0 };
}

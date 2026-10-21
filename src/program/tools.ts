import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { spawnSync } from "node:child_process";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { AuditLogManager } from "../audit-log.js";
import type { ToolActivityLogManager } from "../activity-log.js";
import { API_BRIEF, GUIDELINE_MOTTO, GUIDELINE_TEXT } from "./guideline.js";
import { runProgram } from "./runner.js";
import { globalParkTable } from "./park.js";
import { appendPairHints, composePairHints } from "./pair-hint.js";

export interface JsSurfaceDeps {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  auditLog: AuditLogManager;
  activityLog: ToolActivityLogManager;
  configDir: string;
}

let restartHintPending = true;

export function registerJsSurface(server: McpServer, deps: JsSurfaceDeps): void {
  const { config, workspaces, auditLog, configDir } = deps;

  server.registerTool(
    "open_workspace",
    {
      title: "打开工作区",
      description:
        "打开允许根内的本地项目目录或托管 worktree，返回 workspaceId、总纲与 API 速查。同一文件夹不要重复打开，除非 workspaceId 失效或切换目录。",
      inputSchema: z.object({
        path: z.string().describe("绝对路径，或 ~/… 形式的家目录路径。"),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe("默认 checkout。worktree 创建隔离的托管 Git worktree。"),
        baseRef: z.string().optional().describe("worktree 的基础 Git ref，默认 HEAD。"),
      }),
      outputSchema: z.object({
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
        const body = {
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
          workspaceId: body.workspaceId,
          root: body.root,
          branch: gitBranch(body.root),
          git: gitDirty(body.root),
          parked: globalParkTable.list(body.workspaceId),
          restart: takeRestartHint(),
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
        "在工作区运行一段平铺的异步 JavaScript 程序。输入只有 workspaceId 与 program。" +
        "全部原语均为 this 成员：this.cat/stat/ls/rg/where/whereAll/write/mkdir/mv/rm/call/park，" +
        "以及 this.unpark(handle,arg)/this.abandon(handle)。" +
        "this.call 支持前台命令与 spawn/send/signal/waitFor/read/join。" +
        "写入立即落盘；危险操作与 where 歧义会 park。" +
        "自动 park 时限按 planB 计价：planB 的 UTF-8 字节数 ÷ 20 = 秒数，空 planB 立刻 park。" +
        "互不相干的任务可在同一轮并行调用多个 js。",
      inputSchema: z.object({
        workspaceId: z.string().describe("open_workspace 返回的工作区标识。"),
        program: z.string().min(1).describe("平铺的异步 JavaScript 程序体，可直接 await 顶层。"),
        planB: z
          .string()
          .describe(
            "假如不运行这段程序，你打算怎样继续完成任务？写清楚。" +
              "这是买时间的钱：每 20 字节换 1 秒，用完就自动 park。跑得越久越烦，每多等一秒都要多写 20 字节来证明值得。" +
              "表达完整就停笔，别凑字。写完若发现这个办法已经够用，就直接采用它，不要再跑这段程序。",
          ),
      }),
      outputSchema: z.object({
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
    async ({ workspaceId, program, planB }, ctx) => {
      const budget = { bytes: Buffer.byteLength(planB, "utf8"), ms: Buffer.byteLength(planB, "utf8") * 50 };
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await runProgram({
          workspaceId,
          root: workspace.root,
          allowedRoots: config.allowedRoots,
          configDir,
          stateDir: config.stateDir,
          program,
          yieldBudgetMs: budget.ms,
          planB,
          signal: ctx.mcpReq.signal,
        });

        const summary = formatJsResult(result);
        const risk =
          result.status === "parked" && result.parked?.kind === "confirm"
            ? {
                op: String((result.parked.payload as { danger?: string })?.danger ?? "confirm"),
                target: String((result.parked.payload as { target?: string })?.target ?? ""),
                allowed: false,
              }
            : undefined;

        const hints = composePairHints({
          workspaceId,
          root: workspace.root,
          branch: gitBranch(workspace.root),
          git: gitDirty(workspace.root),
          parked: globalParkTable.list(workspaceId),
          yieldPark: result.status === "parked" && result.parked?.kind === "yield",
          budget,
          restart: takeRestartHint(),
          risk,
          motto: GUIDELINE_MOTTO,
        });

        auditLog.record({
          tool: "js",
          workspaceId,
          action: result.status,
          success: result.status === "done" || result.status === "parked",
          durationMs: Math.round(performance.now() - startedAt),
          error: result.error?.message,
        });

        return {
          isError: result.status === "failed",
          content: [{ type: "text" as const, text: appendPairHints(summary, hints) }],
          structuredContent: {
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
          workspaceId,
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

function takeRestartHint(): boolean {
  if (!restartHintPending) return false;
  restartHintPending = false;
  return true;
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

function gitBranch(root: string): string | undefined {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function gitDirty(root: string) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const lines = result.stdout.split("\n").filter(Boolean);
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

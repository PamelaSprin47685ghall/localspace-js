import type { ParkSiteView } from "./park.js";

export const PAIR_HINT_SEPARATOR = "\u0000\uFEFF";

export interface PairHintInput {
  workspaceId: string;
  root: string;
  branch?: string;
  git?: { staged: number; unstaged: number; untracked: number; ahead?: number; behind?: number; dirty: boolean };
  parked: ParkSiteView[];
  processes?: { name: string; exited: boolean; exitCode: number | null }[];
  yieldPark?: boolean;
  restart?: boolean;
  risk?: { op: string; target?: string; allowed: boolean };
  motto: string;
}

export function composePairHints(input: PairHintInput): string {
  const blocks: string[] = [];
  blocks.push(input.motto.trim());
  const dirty = input.git?.dirty
    ? `dirty ${input.git.staged + input.git.unstaged + input.git.untracked} files`
    : "clean";
  blocks.push(`workspace ${input.workspaceId} @ ${input.root} · branch ${input.branch ?? "?"} · ${dirty}`);
  if (input.parked.length > 0) {
    blocks.push(
      `parked: ${input.parked.map((p) => `${p.handle}(${p.kind})`).join(", ")} — 请 unpark 或 abandon；未表态现场不会自行消失`,
    );
  }
  if (input.processes?.length) {
    blocks.push(
      `processes: ${input.processes.map((p) => (p.exited ? `${p.name} exited=${p.exitCode}` : `${p.name} running`)).join(", ")}`,
    );
  }
  if (input.git?.dirty) {
    blocks.push(
      `git: staged=${input.git.staged} unstaged=${input.git.unstaged} untracked=${input.git.untracked}` +
        (input.git.ahead != null || input.git.behind != null
          ? ` · ahead=${input.git.ahead ?? 0} behind=${input.git.behind ?? 0}`
          : ""),
    );
  }
  if (input.yieldPark) blocks.push("yield: budget=30000 · 用 unpark(handle) 续跑");
  if (input.restart) blocks.push("restart: 进程内 park 现场已清空；以当前磁盘与 git 为准继续");
  if (input.risk) {
    blocks.push(
      `risk: ${input.risk.op}` +
        (input.risk.target ? ` on ${input.risk.target}` : "") +
        ` · allowed=${input.risk.allowed}`,
    );
  }
  return blocks.map((b) => PAIR_HINT_SEPARATOR + b).join("");
}

export function appendPairHints(body: string, hints: string): string {
  return hints ? body + hints : body;
}
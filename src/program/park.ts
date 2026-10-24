import { randomUUID } from "node:crypto";

export type ParkKind = "yield" | "where" | "park" | "confirm";

export interface ParkSite {
  handle: string;
  workspaceId: string;
  kind: ParkKind;
  payload: unknown;
  createdAt: number;
  expiresAt: number;
  elapsedMs: number;
  /** budgetMs: how long the resuming request is willing to wait on a call (its own planB, else 1s). */
  resume: (value: unknown, budgetMs?: number) => Promise<ParkResumeResult>;
  abandon: () => Promise<void>;
  progress?: {
    phase: string;
    stdoutTail?: string;
    stderrTail?: string;
    exitCode?: number | null;
    backgrounds?: { name: string; exited: boolean; exitCode: number | null }[];
  };
}

export interface ParkResumeResult {
  status: "done" | "parked" | "failed" | "abandoned";
  value?: unknown;
  error?: { code: string; message: string };
  parked?: ParkSiteView;
  written: string[];
}

export interface ParkSiteView {
  handle: string;
  kind: ParkKind;
  payload: unknown;
  expiresAt: string;
  elapsedMs: number;
  progress?: ParkSite["progress"];
}

/** Result of claiming a handle: a mismatched workspace never consumes the site. */
export type ParkTake =
  | { status: "ok"; site: ParkSite }
  | { status: "not_found" }
  | { status: "mismatch" };

export class ParkTable {
  private readonly sites = new Map<string, ParkSite>();
  private sweeper?: NodeJS.Timeout;
  /** Unclaimed parks expire after ttlMs; expiry abandons them (kills worker + process groups). */
  constructor(public ttlMs = 30 * 60 * 1000) {}

  create(
    workspaceId: string,
    kind: ParkKind,
    payload: unknown,
    resume: ParkSite["resume"],
    abandon: ParkSite["abandon"],
    options: { elapsedMs?: number; progress?: ParkSite["progress"] } = {},
  ): ParkSite {
    this.prune();
    const now = Date.now();
    const site: ParkSite = {
      handle: `pk_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      workspaceId,
      kind,
      payload,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      elapsedMs: options.elapsedMs ?? 0,
      resume,
      abandon,
      progress: options.progress,
    };
    this.sites.set(site.handle, site);
    this.sweep();
    return site;
  }

  get(handle: string): ParkSite | undefined {
    this.prune();
    const site = this.sites.get(handle);
    if (!site) return undefined;
    if (site.expiresAt <= Date.now()) {
      this.sites.delete(handle);
      void site.abandon().catch(() => undefined);
      return undefined;
    }
    return site;
  }

  /**
   * Claim a handle for one workspace. A handle from another workspace is reported as a
   * mismatch and left untouched: a stray unpark must not consume someone else's live program.
   */
  take(handle: string, workspaceId?: string): ParkTake {
    const site = this.get(handle);
    if (!site) return { status: "not_found" };
    if (workspaceId !== undefined && site.workspaceId !== workspaceId) return { status: "mismatch" };
    this.sites.delete(handle);
    return { status: "ok", site };
  }

  list(workspaceId?: string): ParkSiteView[] {
    this.prune();
    return [...this.sites.values()]
      .filter((site) => !workspaceId || site.workspaceId === workspaceId)
      .map(toView);
  }

  /** Expiry must not depend on someone touching the table: sweep on a timer while sites exist. */
  private sweep(): void {
    if (this.sweeper) return;
    const every = Math.max(50, Math.min(30_000, Math.floor(this.ttlMs / 4)));
    this.sweeper = setInterval(() => {
      this.prune();
      if (this.sites.size === 0) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, every);
    this.sweeper.unref();
  }

  get size(): number {
    return this.sites.size;
  }

  clear(): void {
    for (const site of this.sites.values()) void site.abandon().catch(() => undefined);
    this.sites.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [handle, site] of this.sites) {
      if (site.expiresAt <= now) {
        this.sites.delete(handle);
        void site.abandon().catch(() => undefined);
      }
    }
  }
}

export function toView(site: ParkSite): ParkSiteView {
  return {
    handle: site.handle,
    kind: site.kind,
    payload: site.payload,
    expiresAt: new Date(site.expiresAt).toISOString(),
    elapsedMs: site.elapsedMs,
    progress: site.progress,
  };
}

export const globalParkTable = new ParkTable();
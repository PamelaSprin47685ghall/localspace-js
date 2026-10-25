import { performance } from "node:perf_hooks";

// 每次工具准入只建立一个主线程窗口，恢复目标借用同一个对象。
/** 单次请求最长等待 30 秒：intent 再长也按这个数封顶（= 600 个 UTF-8 字节）。 */
export const MAX_REQUEST_WAIT_MS = 30_000;

/** One authoritative calculation shared by the executor and its advisory receipt. */
export function observeIntentBudget(intent: string): { bytes: number; requestedMs: number; budgetMs: number } {
  const bytes = Buffer.byteLength(intent, "utf8");
  const requestedMs = bytes * 50;
  return { bytes, requestedMs, budgetMs: Math.min(requestedMs, MAX_REQUEST_WAIT_MS) };
}

export class RequestWindow {
  /** 实际生效的等待预算（已封顶）。 */
  readonly budgetMs: number;
  /** intent 换算出来的原始预算，可能大于 budgetMs。 */
  readonly requestedMs: number;
  readonly deadline: number;
  private expired = false;
  private nextId = 0;
  private timer?: NodeJS.Timeout;
  private readonly listeners = new Map<number, () => void>();

  constructor(readonly intent: string) {
    const observed = observeIntentBudget(intent);
    this.requestedMs = observed.requestedMs;
    this.budgetMs = observed.budgetMs;
    this.deadline = performance.now() + this.budgetMs;
  }
  get capped(): boolean { return this.requestedMs > this.budgetMs; }
  remainingMs(): number { return Math.max(0, this.deadline - performance.now()); }
  isOpen(): boolean {
    if (this.expired) return false;
    if (this.remainingMs() <= 0) { this.expire(); return false; }
    return true;
  }
  onExpire(listener: () => void): () => void {
    if (this.expired) { listener(); return () => undefined; }
    const id = ++this.nextId;
    this.listeners.set(id, listener);
    if (this.remainingMs() <= 0) this.expire(); else this.arm();
    return () => {
      this.listeners.delete(id);
      if (this.listeners.size === 0) this.clearTimer();
    };
  }
  private arm(): void {
    if (this.timer !== undefined || this.expired || this.listeners.size === 0) return;
    const remaining = this.remainingMs();
    if (remaining <= 0) { this.expire(); return; }
    // Node 对溢出的延迟会改成 1ms，分段唤醒仍使用原绝对期限。
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.remainingMs() <= 0) this.expire(); else this.arm();
    }, Math.min(2_147_483_647, Math.ceil(remaining)));
  }
  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private expire(): void {
    if (this.expired) return;
    this.expired = true;
    this.clearTimer();
    const listeners = [...this.listeners.values()].reverse();
    this.listeners.clear();
    for (const listener of listeners) listener();
  }
}

import { monitorEventLoopDelay } from "node:perf_hooks";

export interface LagSnapshot {
  maxMs: number;
  p99Ms: number;
  meanMs: number;
}

/**
 * Samples main-thread event-loop delay. Every `intervalMs` it reports the window;
 * windows whose max exceeds `warnMs` are passed to `onLag` (the server logs them).
 */
export function startEventLoopMonitor(opts: {
  intervalMs?: number;
  warnMs?: number;
  onLag: (lag: LagSnapshot) => void;
}): { last: () => LagSnapshot; stop: () => void } {
  const { intervalMs = 10_000, warnMs = 500, onLag } = opts;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let last: LagSnapshot = { maxMs: 0, p99Ms: 0, meanMs: 0 };
  const timer = setInterval(() => {
    const ms = (ns: number) => Math.round(ns / 1e5) / 10;
    last = {
      maxMs: ms(histogram.max),
      p99Ms: ms(histogram.percentile(99)),
      meanMs: Number.isFinite(histogram.mean) ? ms(histogram.mean) : 0,
    };
    histogram.reset();
    if (last.maxMs > warnMs) onLag(last);
  }, intervalMs);
  timer.unref();
  return {
    last: () => last,
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}

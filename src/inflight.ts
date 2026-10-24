// Requests that are still open. A hung /mcp request leaves no traffic record until it closes,
// so this registry is what /healthz reports while a client is stuck.
export interface InflightRequest {
  requestId: string;
  method: string;
  tool?: string;
  workspaceId?: string;
  startedAt: number;
}

const MAX_TRACKED = 256;
const live = new Map<string, InflightRequest>();

/** Register an open request; call the returned function when the response closes. */
export function trackInflight(entry: Omit<InflightRequest, "startedAt">): () => void {
  const key = entry.requestId || `${entry.method}:${live.size}:${Date.now()}`;
  live.set(key, { ...entry, startedAt: Date.now() });
  if (live.size > MAX_TRACKED) {
    const oldest = live.keys().next().value;
    if (oldest !== undefined) live.delete(oldest);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    live.delete(key);
  };
}

export function inflightSnapshot(now = Date.now()): {
  count: number;
  oldestMs: number;
  items: Array<{ method: string; tool?: string; workspaceId?: string; ms: number }>;
} {
  const items = [...live.values()]
    .map((e) => ({ method: e.method, tool: e.tool, workspaceId: e.workspaceId, ms: now - e.startedAt }))
    .sort((a, b) => b.ms - a.ms);
  return { count: items.length, oldestMs: items[0]?.ms ?? 0, items: items.slice(0, 20) };
}

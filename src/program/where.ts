export function whereAll(content: string, needle: string, from = 0): [number, number][] {
  if (!needle) return [];
  const spans: [number, number][] = [];
  let cursor = Math.max(0, from);
  while (cursor <= content.length - needle.length) {
    const found = content.indexOf(needle, cursor);
    if (found < 0) break;
    if (found >= from) spans.push([found, found + needle.length]);
    cursor = found + Math.max(1, needle.length);
  }
  return spans;
}

export interface WhereCandidate {
  span: [number, number];
  context: string;
}

export interface WhereNearest {
  span: [number, number];
  text: string;
  distance: number;
}

export function whereCandidates(content: string, spans: [number, number][]): WhereCandidate[] {
  return spans.slice(0, 8).map(([begin, end]) => ({
    span: [begin, end],
    context: content.slice(Math.max(0, begin - 80), Math.min(content.length, end + 80)),
  }));
}

export function nearestLine(content: string, needle: string): WhereNearest | null {
  if (!needle) return null;
  const lines = content.split("\n");
  let offset = 0;
  let scanned = 0;
  let best: WhereNearest | null = null;
  for (const line of lines) {
    if (scanned >= 2000) break;
    if (line) {
      scanned += 1;
      const distance = editDistance(line, needle);
      if (!best || distance < best.distance) {
        best = { span: [offset, offset + line.length], text: line, distance };
      }
    }
    offset += line.length + 1;
  }
  return best;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}
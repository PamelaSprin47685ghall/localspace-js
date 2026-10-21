export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function whereAll(content: string, needle: string, from = 0): [number, number][] {
  const target = collapseWhitespace(needle);
  if (!target) return [];
  const spans: [number, number][] = [];
  let index = Math.max(0, from);
  while (index < content.length) {
    const match = findNextCollapsed(content, target, index);
    if (!match) break;
    spans.push(match);
    index = match[1];
  }
  return spans;
}

function findNextCollapsed(content: string, target: string, from: number): [number, number] | undefined {
  const map: number[] = [];
  let collapsed = "";
  let i = from;
  while (i < content.length && /\s/.test(content[i]!)) i += 1;
  let lastWasSpace = false;
  for (; i < content.length; i += 1) {
    const ch = content[i]!;
    if (/\s/.test(ch)) {
      if (!lastWasSpace && collapsed.length > 0) {
        collapsed += " ";
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    collapsed += ch;
    map.push(i);
    lastWasSpace = false;
  }
  const at = collapsed.indexOf(target);
  if (at < 0) return undefined;
  const begin = map[at]!;
  const end = map[at + target.length - 1]! + 1;
  return [begin, end];
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
  const target = collapseWhitespace(needle);
  if (!target) return null;
  const lines = content.split("\n");
  let offset = 0;
  let scanned = 0;
  let best: WhereNearest | null = null;
  for (const line of lines) {
    if (scanned >= 2000) break;
    const trimmed = line.trim();
    if (trimmed) {
      scanned += 1;
      const distance = editDistance(trimmed, target);
      if (!best || distance < best.distance) {
        const begin = offset + Math.max(0, line.indexOf(trimmed));
        best = { span: [begin, begin + trimmed.length], text: trimmed, distance };
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
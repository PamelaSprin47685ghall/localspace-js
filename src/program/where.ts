export function whereAll(content: string, needle: string): [number, number][] {
  if (!needle) return [];
  const spans: [number, number][] = [];
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const found = content.indexOf(needle, cursor);
    if (found < 0) break;
    spans.push([found, found + needle.length]);
    cursor = found + Math.max(1, needle.length);
  }
  return spans;
}

export interface WhereCandidate {
  span: [number, number];
  context: string;
}

export function whereCandidates(content: string, spans: [number, number][]): WhereCandidate[] {
  return spans.slice(0, 8).map(([begin, end]) => ({
    span: [begin, end],
    context: content.slice(Math.max(0, begin - 80), Math.min(content.length, end + 80)),
  }));
}
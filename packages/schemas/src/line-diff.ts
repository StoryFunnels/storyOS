/**
 * A line diff of two texts, for showing a person what an update would change in something they edited (#977's agent instructions).
 * Longest-common-subsequence over LINES: small texts (instructions are capped at a few thousand characters), so O(n*m) is fine, and
 * the output is the plain `same | add | remove` sequence a client renders without a diff library.
 */
export type DiffLine = { op: 'same' | 'add' | 'remove'; text: string };

export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from.split('\n');
  const b = to.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: 'remove', text: a[i++]! });
    else out.push({ op: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ op: 'remove', text: a[i++]! });
  while (j < b.length) out.push({ op: 'add', text: b[j++]! });
  return out;
}

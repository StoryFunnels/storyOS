/**
 * Parses GitHub's own unified `patch` text (returned per-file by
 * `GET /repos/{o}/{r}/pulls/{n}/files`) into rows a diff view can render.
 *
 * No diff algorithm lives here — GitHub already computed the diff; this only
 * reads its unified-diff hunks (`@@ -a,b +c,d @@`) back into structured rows.
 * That's a deliberate scope choice for #43 (see PR description): the codebase
 * has no diff/code-highlighting dependency to reach for (checked apps/web's
 * package.json first), and every other GitHub-App credential in this codebase
 * is hand-rolled the same way (RS256 JWT in github-app.service.ts, HMAC in
 * github-webhook.service.ts) rather than pulling in a library for something
 * this contained.
 */

export type DiffRowKind = 'hunk' | 'context' | 'add' | 'del' | 'no-newline';

export interface DiffRow {
  kind: DiffRowKind;
  /** Old-file line number; undefined for hunk headers and pure additions. */
  oldLine?: number;
  /** New-file line number; undefined for hunk headers and pure deletions. */
  newLine?: number;
  content: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parse one file's unified patch into flat rows, in original order. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split('\n')) {
    const hunk = line.match(HUNK_RE);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      rows.push({ kind: 'hunk', content: line });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', newLine, content: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldLine, content: line.slice(1) });
      oldLine++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — a marker, not a line of the file.
      rows.push({ kind: 'no-newline', content: line.slice(1).trim() });
    } else {
      // A context line starts with a single space GitHub always includes;
      // slice(1) if present, else take the (rare empty) line as-is.
      rows.push({ kind: 'context', oldLine, newLine, content: line.startsWith(' ') ? line.slice(1) : line });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}

/** One row of the split (side-by-side) view — a left (old) and/or right (new) cell,
 *  or a full-width `marker` (hunk header / "no newline" notice). */
export interface SplitRow {
  left: { line?: number; content: string; kind: 'context' | 'del' | 'empty' } | null;
  right: { line?: number; content: string; kind: 'context' | 'add' | 'empty' } | null;
  marker?: string;
}

/**
 * Turn flat unified rows into side-by-side pairs. Context lines pair with
 * themselves; a run of deletions is zipped against the run of additions that
 * follows it (the conventional "naive" split-diff pairing — not a word-level
 * re-diff, which would need an actual diff algorithm this file deliberately
 * doesn't take on). Unequal-length runs pad the shorter side with an empty cell.
 */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.kind === 'hunk' || row.kind === 'no-newline') {
      out.push({ left: null, right: null, marker: row.content });
      i++;
      continue;
    }
    if (row.kind === 'context') {
      out.push({
        left: { line: row.oldLine, content: row.content, kind: 'context' },
        right: { line: row.newLine, content: row.content, kind: 'context' },
      });
      i++;
      continue;
    }
    // A del/add run: collect consecutive dels, then consecutive adds, then zip.
    const dels: DiffRow[] = [];
    while (i < rows.length && rows[i]!.kind === 'del') dels.push(rows[i++]!);
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i]!.kind === 'add') adds.push(rows[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const del = dels[k];
      const add = adds[k];
      out.push({
        left: del ? { line: del.oldLine, content: del.content, kind: 'del' } : { kind: 'empty', content: '' },
        right: add ? { line: add.newLine, content: add.content, kind: 'add' } : { kind: 'empty', content: '' },
      });
    }
  }
  return out;
}

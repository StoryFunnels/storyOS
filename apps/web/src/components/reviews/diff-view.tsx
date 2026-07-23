'use client';

import { useMemo, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parsePatch, toSplitRows } from './diff-parse';
import type { DiffRow } from './diff-parse';

export type DiffMode = 'unified' | 'split';

export interface DiffThread {
  line: number;
  side: 'LEFT' | 'RIGHT';
  count: number;
}

/** A file's diff — unified or split — rendered from GitHub's own `patch` text
 *  (see diff-parse.ts). Click a gutter to start a comment on that line/side. */
export function DiffView({
  patch,
  mode,
  threads = [],
  onCommentLine,
}: {
  patch: string | null;
  mode: DiffMode;
  /** Lines that already have a comment thread — shown as a small badge in the gutter. */
  threads?: DiffThread[];
  onCommentLine?: (line: number, side: 'LEFT' | 'RIGHT') => void;
}) {
  const rows = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);
  const threadFor = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of threads) m.set(`${t.side}:${t.line}`, t.count);
    return m;
  }, [threads]);

  if (!patch) {
    return (
      <div className="p-4 text-[13px] text-muted">
        No diff to show — binary file, or GitHub declined to compute one (very large change).
      </div>
    );
  }

  return mode === 'unified' ? (
    <UnifiedTable rows={rows} threadFor={threadFor} onCommentLine={onCommentLine} />
  ) : (
    <SplitTable rows={rows} threadFor={threadFor} onCommentLine={onCommentLine} />
  );
}

function rowBg(kind: DiffRow['kind']) {
  if (kind === 'add') return 'bg-success/10';
  if (kind === 'del') return 'bg-error/10';
  if (kind === 'hunk') return 'bg-surface';
  return undefined;
}

/** A gutter cell: line number, hoverable to reveal an "add comment" affordance,
 *  and a small dot when a thread already exists there. */
function Gutter({
  line,
  side,
  hasThread,
  onComment,
}: {
  line?: number;
  side: 'LEFT' | 'RIGHT';
  hasThread: boolean;
  onComment?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <td
      className="group w-12 shrink-0 select-none border-r border-border-default px-1.5 text-right align-top text-[11px] text-faint"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="flex items-center justify-end gap-1">
        {onComment && line !== undefined && (hover || hasThread) && (
          <button
            type="button"
            title="Add a comment on this line"
            onClick={onComment}
            className={cn(
              'rounded p-0.5 hover:bg-active hover:text-ink',
              hasThread ? 'text-info' : 'text-faint',
            )}
          >
            <MessageSquarePlus className="h-3 w-3" />
          </button>
        )}
        {line ?? ''}
      </span>
      <span className="sr-only">{side}</span>
    </td>
  );
}

function UnifiedTable({
  rows,
  threadFor,
  onCommentLine,
}: {
  rows: DiffRow[];
  threadFor: Map<string, number>;
  onCommentLine?: (line: number, side: 'LEFT' | 'RIGHT') => void;
}) {
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-5">
      <tbody>
        {rows.map((row, i) => {
          if (row.kind === 'hunk') {
            return (
              <tr key={i} className={rowBg('hunk')}>
                <td colSpan={3} className="px-2 py-1 text-[11px] text-muted">
                  {row.content}
                </td>
              </tr>
            );
          }
          if (row.kind === 'no-newline') {
            return (
              <tr key={i}>
                <td colSpan={3} className="px-2 py-0.5 text-[11px] italic text-faint">
                  {row.content}
                </td>
              </tr>
            );
          }
          return (
            <tr key={i} className={rowBg(row.kind)}>
              <Gutter
                line={row.oldLine}
                side="LEFT"
                hasThread={row.kind !== 'add' && row.oldLine !== undefined && threadFor.has(`LEFT:${row.oldLine}`)}
                onComment={
                  onCommentLine && row.kind !== 'add' && row.oldLine !== undefined
                    ? () => onCommentLine(row.oldLine!, 'LEFT')
                    : undefined
                }
              />
              <Gutter
                line={row.newLine}
                side="RIGHT"
                hasThread={row.kind !== 'del' && row.newLine !== undefined && threadFor.has(`RIGHT:${row.newLine}`)}
                onComment={
                  onCommentLine && row.kind !== 'del' && row.newLine !== undefined
                    ? () => onCommentLine(row.newLine!, 'RIGHT')
                    : undefined
                }
              />
              <td className="whitespace-pre px-2 text-ink">
                <span
                  className={cn(
                    'mr-1 inline-block w-3 text-center select-none',
                    row.kind === 'add' && 'text-success',
                    row.kind === 'del' && 'text-error',
                  )}
                >
                  {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''}
                </span>
                {row.content}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SplitTable({
  rows,
  threadFor,
  onCommentLine,
}: {
  rows: DiffRow[];
  threadFor: Map<string, number>;
  onCommentLine?: (line: number, side: 'LEFT' | 'RIGHT') => void;
}) {
  const split = useMemo(() => toSplitRows(rows), [rows]);
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-5">
      <tbody>
        {split.map((row, i) => {
          if (row.marker !== undefined) {
            return (
              <tr key={i} className={rowBg('hunk')}>
                <td colSpan={4} className="px-2 py-1 text-[11px] text-muted">
                  {row.marker}
                </td>
              </tr>
            );
          }
          return (
            <tr key={i}>
              <Gutter
                line={row.left?.line}
                side="LEFT"
                hasThread={row.left?.line !== undefined && threadFor.has(`LEFT:${row.left.line}`)}
                onComment={
                  onCommentLine && row.left?.line !== undefined
                    ? () => onCommentLine(row.left!.line!, 'LEFT')
                    : undefined
                }
              />
              <td className={cn('whitespace-pre px-2 text-ink', rowBg(row.left?.kind === 'del' ? 'del' : 'context'))}>
                {row.left?.content}
              </td>
              <Gutter
                line={row.right?.line}
                side="RIGHT"
                hasThread={row.right?.line !== undefined && threadFor.has(`RIGHT:${row.right.line}`)}
                onComment={
                  onCommentLine && row.right?.line !== undefined
                    ? () => onCommentLine(row.right!.line!, 'RIGHT')
                    : undefined
                }
              />
              <td className={cn('whitespace-pre px-2 text-ink', rowBg(row.right?.kind === 'add' ? 'add' : 'context'))}>
                {row.right?.content}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

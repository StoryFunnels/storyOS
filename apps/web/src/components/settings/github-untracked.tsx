'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/preferences';
import { untrackedModel, type IgnoredDeliveries } from '@/lib/github-untracked';

/** Ticket #1221: "Not tracked, but sending events · N repositories", each a row with a Track button; the first 3, then "Show all". */
export function GithubUntracked({
  ignored,
  tracked,
  tracking,
  onTrack,
}: {
  ignored: IgnoredDeliveries | undefined;
  tracked: readonly string[];
  /** The repository whose Track is in flight, if any. */
  tracking: string | null;
  onTrack: (repo: string) => void;
}) {
  const fmt = useDateFormat();
  const [showAll, setShowAll] = useState(false);
  const m = untrackedModel(ignored, tracked, showAll);
  if (!m.heading) return null;
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="github-ignored-deliveries"
      aria-label="Repositories not tracked"
    >
      <h2 className="text-body font-semibold text-ink">{m.heading}</h2>
      {m.rows.length > 0 && (
        <ul className="rounded-[var(--radius-card)] border border-border-default bg-card">
          {m.rows.map((r) => (
            <li
              key={r.repo}
              data-testid="github-untracked-row"
              className="flex min-h-[46px] flex-wrap items-center gap-3 border-t border-border-default px-3.5 py-2 text-body first:border-t-0"
            >
              <span className="flex min-w-0 flex-1 basis-48 flex-col leading-[1.35]">
                <code className="truncate font-mono text-body font-medium text-ink">{r.repo}</code>
                <span className="text-label text-muted">
                  {r.count} {r.count === 1 ? 'event' : 'events'} · last{' '}
                  {fmt.dateTime(r.last_seen_at)}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={tracking !== null}
                onClick={() => onTrack(r.repo)}
                aria-label={`Track ${r.repo}`}
              >
                {tracking === r.repo ? 'Tracking…' : 'Track'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {m.hiddenCount > 0 && (
        <p className="text-label text-muted">
          and {m.hiddenCount} more ·{' '}
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={() => setShowAll(true)}
          >
            Show all
          </button>
        </p>
      )}
      {m.otherDeliveries > 0 && (
        <p className="text-label text-muted">
          Plus {m.otherDeliveries} {m.otherDeliveries === 1 ? 'event' : 'events'} from other
          repositories StoryOS does not list by name.
        </p>
      )}
    </section>
  );
}

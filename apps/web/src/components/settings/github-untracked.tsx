'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SettingsBox, SettingsRow } from '@/components/settings/settings-chrome';
import { useDateFormat } from '@/lib/preferences';
import { untrackedModel, untrackedDetail, type IgnoredDeliveries } from '@/lib/github-untracked';

/**
 * Ticket #1221: ONE box (the shared `SettingsBox`, as every other Settings box): a header row "Not tracked, but sending events" with a
 * muted "N repositories" at its right, a row per repository with Track, and "and N more" + Show all as the box's last row.
 */
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
  if (!m.title) return null;
  return (
    <div data-testid="github-ignored-deliveries" aria-label="Repositories not tracked">
      <SettingsBox title={m.title} aside={m.count}>
        {m.rows.map((r) => (
          <SettingsRow
            key={r.repo}
            testId="github-untracked-row"
            title={<code className="block font-mono text-meta leading-[1.35]!">{r.repo}</code>}
            description={untrackedDetail(r, (iso) => fmt.dateTime(iso))}
          >
            <Button size="sm" variant="secondary" disabled={tracking !== null} onClick={() => onTrack(r.repo)} aria-label={`Track ${r.repo}`}>
              {tracking === r.repo ? 'Tracking…' : 'Track'}
            </Button>
          </SettingsRow>
        ))}
        {m.otherDeliveries > 0 && (
          <p className="border-t border-border-default px-3.5 py-2 text-label text-muted first:border-t-0">
            Plus {m.otherDeliveries} {m.otherDeliveries === 1 ? 'event' : 'events'} from other repositories StoryOS does not list by name.
          </p>
        )}
        {m.hiddenCount > 0 && (
          <SettingsRow title={<span className="font-normal text-muted">and {m.hiddenCount} more</span>}>
            <Button size="sm" variant="secondary" onClick={() => setShowAll(true)}>
              Show all
            </Button>
          </SettingsRow>
        )}
      </SettingsBox>
    </div>
  );
}

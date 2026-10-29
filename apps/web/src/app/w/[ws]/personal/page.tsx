'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FileText, Table2, UserRound } from 'lucide-react';
import { usePersonalDocs, usePersonalSpace, usePersonalViews } from '@/components/personal-section';
import { VIEW_ICON } from '@/components/views/view-tab';
import { PERSONAL_PRIVACY_SENTENCE } from '@/lib/personal-space-copy';

/**
 * Ticket #1097 — the Personal page: what the sidebar's "Personal" row opens (Dara's #932 prototype's `personalPage`).
 *
 * Its header carries the privacy sentence, word for word (personal-space.md §1: "say so at the point of use"), because this is
 * where the sidebar paragraph moved to. The lists are the same queries the sidebar row runs (same keys), so the page and the
 * tree cannot disagree. A personal VIEW is a lens on shared data (personal-space.md §3), so each one names the database it
 * reads from, since it no longer appears under that database in the sidebar.
 */
export default function PersonalPage() {
  const { ws } = useParams<{ ws: string }>();
  const space = usePersonalSpace(ws);
  const docs = usePersonalDocs(ws, space.data?.id);
  const views = usePersonalViews(ws);
  const docItems = docs.data ?? [];
  const viewItems = views.data ?? [];
  const loading = space.isPending || docs.isPending || views.isPending;
  const empty = !loading && docItems.length === 0 && viewItems.length === 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-title font-semibold text-ink">
          <UserRound className="h-[18px] w-[18px] text-muted" aria-hidden /> Personal
        </h1>
        <p className="mt-2 max-w-prose text-body text-muted" data-testid="personal-privacy">
          {PERSONAL_PRIVACY_SENTENCE}
        </p>
      </header>

      {loading && <p className="text-body text-muted">Loading…</p>}

      {empty && (
        <p className="text-body text-muted">
          Nothing here yet. Use the + next to Personal in the sidebar to make a document or a view.
        </p>
      )}

      {docItems.length > 0 && (
        <section className="mb-6" aria-labelledby="personal-docs">
          <h2 id="personal-docs" className="mb-2 text-meta font-semibold uppercase tracking-wider text-muted">
            Documents <span className="font-normal">{docItems.length}</span>
          </h2>
          <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
            {docItems.map((d) => (
              <li key={d.id} className="border-b border-border-default last:border-b-0">
                <Link href={`/w/${ws}/doc/${d.id}`} className="flex items-center gap-2 px-3 py-2 text-body text-ink hover:bg-hover">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0 truncate">{d.title || 'Untitled'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {viewItems.length > 0 && (
        <section aria-labelledby="personal-views">
          <h2 id="personal-views" className="mb-2 text-meta font-semibold uppercase tracking-wider text-muted">
            Views <span className="font-normal">{viewItems.length}</span>
          </h2>
          <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
            {viewItems.map((v) => {
              const Icon = VIEW_ICON[v.type as keyof typeof VIEW_ICON] ?? Table2;
              return (
                <li key={v.id} className="border-b border-border-default last:border-b-0">
                  <Link
                    href={`/w/${ws}/d/${v.database_id}?view=${v.id}`}
                    className="flex items-center gap-2 px-3 py-2 text-body text-ink hover:bg-hover"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                    <span className="min-w-0 truncate">{v.name}</span>
                    {v.database_name && <span className="ml-auto shrink-0 text-label text-muted">a lens on {v.database_name}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

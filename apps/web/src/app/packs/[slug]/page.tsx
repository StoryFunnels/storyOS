import Link from 'next/link';
import type { Metadata } from 'next';
import { API_URL } from '@/lib/api';

/**
 * Public, pre-signup Business Pack preview (#272).
 *
 * A plain server component — no session, no react-query, no app chrome — so a
 * pack link shared outside StoryOS (Twitter, Reddit, a README) renders for
 * someone who has never signed up. Hits the unauthenticated
 * `GET /api/v1/public/packs/registry/:slug` (`public-packs.controller.ts`)
 * directly with `fetch`, the same way `f/[token]/page.tsx` does for public
 * forms — no cookies, no react-query cache to seed.
 *
 * Finding: before this, the only pack UI was `w/[ws]/packs/page.tsx`, gated
 * by the workspace layout's session redirect, and the registry endpoint it
 * calls required `AuthGuard` — so a shared pack link hit a login wall no
 * matter how good the pack was. This route plus the public API route are the
 * fix; nothing about install itself changed.
 */

interface PackPublicPreview {
  slug: string;
  name: string;
  summary: string;
  highlights: string[];
  requires: { connections: string[]; ai: 'none' | 'byo' | 'storyos' };
  contents: {
    databases: string[];
    views: string[];
    automations: string[];
    agents: string[];
    skills: string[];
  };
}

async function getPack(slug: string): Promise<PackPublicPreview | null> {
  const res = await fetch(`${API_URL}/api/v1/public/packs/registry/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as PackPublicPreview;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const pack = await getPack(slug);
  if (!pack) return { title: 'Pack not found' };
  const title = `${pack.name} — a StoryOS Business Pack`;
  return {
    title,
    description: pack.summary,
    openGraph: { title, description: pack.summary, type: 'website' },
    twitter: { card: 'summary', title, description: pack.summary },
  };
}

const AI_LABEL: Record<PackPublicPreview['requires']['ai'], string | null> = {
  none: null,
  byo: 'Runs on your own AI (never metered)',
  storyos: 'Uses StoryOS-managed AI',
};

const CONTENT_SECTIONS: Array<{ key: keyof PackPublicPreview['contents']; label: string }> = [
  { key: 'databases', label: 'Databases' },
  { key: 'views', label: 'Views' },
  { key: 'automations', label: 'Automations' },
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
];

export default async function PackPublicPreviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const pack = await getPack(slug);

  if (!pack) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-md rounded-[var(--radius-modal)] border border-border-default bg-card p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">Pack not found</h1>
          <p className="mt-2 text-[13px] text-muted">
            This pack doesn&rsquo;t exist, or is no longer in the gallery.
          </p>
          <Link
            href="/signup"
            className="mt-6 inline-flex h-9 items-center justify-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-[var(--text-on-dark)] hover:bg-primary-hover"
          >
            Sign up for StoryOS
          </Link>
        </div>
      </main>
    );
  }

  const sections = CONTENT_SECTIONS.map((s) => ({ ...s, items: pack.contents[s.key] })).filter(
    (s) => s.items.length > 0,
  );
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  const aiNote = AI_LABEL[pack.requires.ai];

  return (
    <main className="min-h-screen bg-canvas px-4 py-12">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex items-center gap-2">
          <img src="/brand/mark.svg" alt="" className="h-6 w-6" />
          <span className="text-[13px] font-medium text-muted">StoryOS Business Pack</span>
        </div>

        <div className="rounded-[var(--radius-modal)] border border-border-default bg-card p-8">
          <h1 className="text-2xl font-semibold text-ink">{pack.name}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">{pack.summary}</p>

          {pack.highlights.length > 0 && (
            <ul className="mt-5 flex flex-col gap-1.5">
              {pack.highlights.map((h) => (
                <li key={h} className="flex items-start gap-2 text-[13px] text-ink-secondary">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
                  {h}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="inline-flex h-10 items-center justify-center rounded-[var(--radius-control)] bg-primary px-5 text-sm font-medium text-[var(--text-on-dark)] hover:bg-primary-hover"
            >
              Sign up free to install
            </Link>
            <span className="text-[12px] text-faint">No credit card required</span>
          </div>
        </div>

        {sections.length > 0 && (
          <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-6">
            <p className="mb-4 text-[13px] font-semibold text-ink">
              What&rsquo;s included — {totalItems} item{totalItems === 1 ? '' : 's'}
            </p>
            <div className="flex flex-col gap-4">
              {sections.map((s) => (
                <div key={s.key}>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
                    {s.label} · {s.items.length}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {s.items.map((item) => (
                      <span
                        key={item}
                        className="rounded-full bg-hover px-2.5 py-1 text-[12px] text-ink-secondary"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {(aiNote || pack.requires.connections.length > 0) && (
          <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-6">
            <p className="mb-2 text-[13px] font-semibold text-ink">Good to know</p>
            <ul className="flex flex-col gap-1 text-[13px] text-muted">
              {aiNote && <li>{aiNote}</li>}
              {pack.requires.connections.length > 0 && (
                <li>Works best connected to: {pack.requires.connections.join(', ')}</li>
              )}
            </ul>
          </div>
        )}

        <p className="text-center text-[12px] text-faint">
          <Link href="/signup" className="underline underline-offset-2">
            Sign up
          </Link>{' '}
          to install this pack into your own workspace in one click.
        </p>
      </div>
    </main>
  );
}

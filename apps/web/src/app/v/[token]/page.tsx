import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SERVER_API_URL } from '@/lib/api';
import { PublicViewClient } from './public-view-client';
import type { PublicViewDef } from './public-view-client';

/**
 * Public, unauthenticated view (#264/#527/#566). A plain SERVER component —
 * no session, no react-query — mirroring `packs/[slug]/page.tsx`'s shape,
 * itself mirroring `f/[token]/page.tsx`'s status-state-machine idea but done
 * server-side, which #566 exists to fix: the previous client-only page
 * always answered HTTP 200 and served the generic homepage's og:title/image,
 * because the server never knew the token until the browser fetched it.
 *
 * `generateMetadata` and the page component both resolve the token — Next
 * dedupes identical `fetch()` calls within one request, so this is one round
 * trip, not two. `PublicViewsService`'s own redaction (the allowlist, the
 * uniform NotFoundException for every "missing" reason) is untouched — this
 * only moves WHERE the resolve happens, never re-implements it.
 *
 * TABLE ONLY: see the interactive component's own note in public-view-client.tsx
 * for the board/dashboard scope decision (#555) unchanged from #527.
 */

async function getView(token: string, cursor?: string): Promise<PublicViewDef | null> {
  const url = new URL(`${SERVER_API_URL}/api/v1/public/views/${encodeURIComponent(token)}`);
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as PublicViewDef;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const def = await getView(token);
  if (!def) return { title: 'View not found' };
  const title = `${def.view.name} — ${def.database.name}`;
  const description = `A shared view from "${def.database.name}", published with StoryOS.`;
  return {
    title,
    description,
    // #566 AC1 — `openGraph`/`twitter` REPLACE the root layout's object rather
    // than merging field-by-field, so omitting `images` here would silently
    // drop the site's og:image entirely rather than inheriting it. No
    // per-view image exists, so the same site image — but it must be
    // restated, not assumed to carry over.
    openGraph: { title, description, type: 'website', images: [{ url: '/og.png', width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] },
  };
}

export default async function PublicViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { token } = await params;
  const { embed } = await searchParams;
  const def = await getView(token);
  if (!def) notFound();
  return <PublicViewClient token={token} initialDef={def} embed={embed === '1'} />;
}

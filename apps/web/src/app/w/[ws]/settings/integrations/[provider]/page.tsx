'use client';

import { QuillNotFound } from '@/components/quill/not-found-view';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { providerPage, providerPageHref } from '@/lib/provider-pages';
import { CUSTOM_API_PRESETS } from '@/lib/custom-api-presets';
import { ProviderConnectionCard, ProviderPageHeader } from '@/components/settings/provider-card';

/** What a connection is for once it is saved, for the providers whose page is nothing but the card (they have no setup of their own). */
const AFTER_CONNECT: Record<string, string> = {
  email: 'Choose this connection in a Send email button or automation action.',
  'custom-api': 'Choose this connection in an HTTP request button or automation action.',
  apify: 'Open the destination database, choose Sources, then add an Apify source.',
  openai: 'Tyron uses this key for its answers once it is connected.',
};

/**
 * Ticket #1188 — the page for every provider that has no setup screen of its own (Email, Custom API, Apify, OpenAI). They had no page
 * at all: their only home was /connections, which is now merged into provider pages. Providers WITH a setup screen (GitHub, Linear,
 * Shopify...) have their own folder, which Next serves in preference to this route. All of them draw the same connection card.
 */
export default function GenericProviderPage() {
  const { ws, provider } = useParams<{ ws: string; provider: string }>();
  const def = providerPage(provider);
  // #1291 — a provider that does not exist is the 404 page (the same one every other missing thing gets), not a one-off sentence.
  if (!def || def.backing.kind === 'builtin') return <QuillNotFound />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-[18px] p-4 sm:p-8">
      <ProviderPageHeader ws={ws} id={def.id} />
      <ProviderConnectionCard ws={ws} id={def.id} />
      {AFTER_CONNECT[def.id] && (
        <p className="text-body text-muted">
          <strong className="font-semibold text-ink-secondary">After connecting:</strong> {AFTER_CONNECT[def.id]}
        </p>
      )}
      {def.id === 'custom-api' && (
        <p className="text-body text-muted" data-testid="custom-api-presets">
          Presets pre-fill the connect form with the right address and auth for a platform:{' '}
          {CUSTOM_API_PRESETS.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <Link href={providerPageHref(ws, p.id)} className="text-ink underline underline-offset-2">
                {p.label}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}

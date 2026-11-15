import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SERVER_API_URL } from '@/lib/api';
import { fetchPublicJson } from '@/lib/public-fetch';
import { PublicFormClient, type FormDef } from './public-form-client';

/**
 * Public, unauthenticated form. A SERVER component since ticket #1291: the definition is resolved here, so an unknown, revoked or
 * unpublished token is a real HTTP 404 with the shared 404 page (`./not-found.tsx`, no app shell), identical for "never existed"
 * and "private" — and a failed load (API down, 5xx) throws to `./error.tsx`, a retry, instead of reading as "Form not found" the
 * way the old client-side fetch did for every failure. The interactive form itself is `./public-form-client.tsx`.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function PublicFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const def = await fetchPublicJson<FormDef>(`${SERVER_API_URL}/api/v1/public/forms/${encodeURIComponent(token)}`);
  if (!def) notFound();
  return <PublicFormClient token={token} initialDef={def} />;
}

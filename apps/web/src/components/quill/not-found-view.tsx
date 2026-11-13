'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MARKETING_LABEL, MARKETING_URL } from '@/lib/marketing';
import { Quill } from './quill';

/**
 * #1253 — the 404, from Dara's prototype v73 (a row of the placement table Ievgen approved on 2026-11-04): Quill lost, what is
 * true in plain words, and the one way back. No gold, and her caption is the only kitchen word on the page.
 *
 * "Go home" is the workspace's Home when the URL names a workspace, else the app's entry route (which routes on to the person's
 * workspace, or to sign-in). There is deliberately NO "Search" link: the prototype draws none because it has no search to open.
 */
export function homeHrefFor(ws: string | undefined): string {
  return ws ? `/w/${ws}` : '/';
}

function NotFoundBody({ action }: { action: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[440px] flex-col items-center gap-2.5 px-4 pb-10 pt-[12vh] text-center" data-testid="not-found">
      <Quill pose="lost" size={120} caption="This was a page once." captionClassName="max-w-[160px] text-[16px]" />
      <h1 className="m-0 mt-1.5 text-title font-bold leading-[1.25] text-ink">This page doesn’t exist</h1>
      <p className="m-0 text-body text-muted">It may have moved, or the link is wrong.</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3.5">{action}</div>
    </div>
  );
}

export function QuillNotFound() {
  const ws = useParams<{ ws?: string }>()?.ws;
  return (
    <NotFoundBody
      action={
        <Link href={homeHrefFor(ws)} className={cn(buttonVariants({ variant: 'primary' }))}>
          Go home
        </Link>
      }
    />
  );
}

/**
 * Ticket #1291 — the SAME 404, for a signed-out public page (form, skill share, public view, pack landing) with an unknown,
 * revoked, unpublished or private id. No app shell around it, and the one way back is the product's front door: there is no
 * workspace home when nobody is signed in. A plain <a>, not <Link>: it leaves the app for the marketing site.
 */
export function PublicNotFound() {
  return (
    <NotFoundBody
      action={
        <a href={MARKETING_URL} className={cn(buttonVariants({ variant: 'primary' }))}>
          Go to {MARKETING_LABEL}
        </a>
      }
    />
  );
}

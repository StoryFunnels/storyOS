'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

/**
 * Ticket #1302 reuses this shape for an invite link that no longer works (no shell around it, the one way forward under it): the
 * page-specific words and the action come in as props, and with none given the output is the 404 above, unchanged.
 */
export interface QuillNoticeProps {
  title?: string;
  body?: string;
  caption?: string;
  action?: { href: string; label: string };
}

export function QuillNotFound({ title = 'This page doesn’t exist', body = 'It may have moved, or the link is wrong.', caption = 'This was a page once.', action }: QuillNoticeProps = {}) {
  const ws = useParams<{ ws?: string }>()?.ws;
  return (
    <div className="mx-auto flex max-w-[440px] flex-col items-center gap-2.5 px-4 pb-10 pt-[12vh] text-center" data-testid="not-found">
      <Quill pose="lost" size={120} caption={caption} captionClassName="max-w-[160px] text-[16px]" />
      <h1 className="m-0 mt-1.5 text-title font-bold leading-[1.25] text-ink">{title}</h1>
      <p className="m-0 text-body text-muted">{body}</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3.5">
        <Link href={action?.href ?? homeHrefFor(ws)} className={cn(buttonVariants({ variant: 'primary' }))}>
          {action?.label ?? 'Go home'}
        </Link>
      </div>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import { MoreHorizontal } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { CollapseToggle } from './collapsible-section';
import { MarkdownMenuItems, type MarkdownProvider } from './markdown-actions';

/**
 * Ticket #954 — ONE header for every long-text block on the record page: a promoted `text` field,
 * a `rich_text` field and the record's description. They used to be three components with three
 * header typographies, the copy/download icons in two different places, and one block with no menu.
 *
 * Shape: [caret] LABEL [⋯] and nothing on the right. The ⋯ is passed in because a field block uses
 * the field menu and the description (which is not a field) uses `LongTextMenu` below.
 */
export function LongTextHeader({
  label,
  collapsed,
  onToggle,
  menu,
}: {
  label: string;
  collapsed?: boolean;
  onToggle?: () => void;
  menu?: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex h-5 items-center gap-1">
      {onToggle && <CollapseToggle collapsed={Boolean(collapsed)} onToggle={onToggle} label={label} />}
      <h2 className="text-label font-medium uppercase tracking-wider text-muted">{label}</h2>
      {menu}
    </div>
  );
}

/** The ⋯ for a block that is not a field (the description): Copy, Download, and Hide. */
export function LongTextMenu({
  label,
  markdown,
  onHide,
  hideLabel,
}: {
  label: string;
  markdown?: MarkdownProvider;
  onHide?: () => void;
  hideLabel?: string;
}) {
  if (!markdown && !onHide) return null;
  return (
    <DropdownMenu>
      <Tooltip label="Options">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Options for ${label}`}
            className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start">
        {markdown && <MarkdownMenuItems markdown={markdown} />}
        {markdown && onHide && <DropdownMenuSeparator />}
        {onHide && <DropdownMenuItem onSelect={onHide}>{hideLabel ?? 'Hide on record page'}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The surface behind a long-text body: nothing at rest, a card on hover, focus or while editing.
 * Two of the three blocks were permanently boxed, so a record with three long fields was three
 * stacked boxes before anything was touched. The surface is the affordance, not the default.
 */
export const BLOCK_SURFACE =
  'rounded-[var(--radius-card)] border border-transparent transition-colors hover:border-border-default hover:bg-card focus-within:border-border-default focus-within:bg-card';

/**
 * The BlockNote body of a rich_text field and of the description: the same surface, and the same
 * horizontal geometry. `.bn-editor` carries a 52px left gutter for BlockNote's hover side menu
 * (insert and drag handle), so the box is pulled 52px left and widened by 52px to put the TEXT on the
 * column edge (#642). On a device that cannot hover there is no handle and globals.css drops the
 * gutter (#899), so the box instead grows 12px each way: text still on the column edge, surface
 * reaching into the page gutter, never off-screen.
 */
export const BLOCKNOTE_BODY = cn(
  BLOCK_SURFACE,
  '-ml-[52px] min-h-12 w-[calc(100%+52px)] py-3 [&_.bn-editor]:bg-transparent',
  '[@media(hover:none)_and_(pointer:coarse)]:-ml-3 [@media(hover:none)_and_(pointer:coarse)]:w-[calc(100%+24px)] [@media(hover:none)_and_(pointer:coarse)]:px-3',
);

/** Elements a `text` field's Markdown may render. No raw HTML (untrusted input, and no rehype-raw),
 * no images (a remote URL in a synced field would be fetched on view). */
const ALLOWED = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
];

/**
 * A `text` field's stored string, drawn as Markdown at rest. Display only: the stored value is
 * never touched, and one click on the block swaps this for the raw source.
 */
export function MarkdownBody({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn('text-reading text-ink-secondary [&>*+*]:mt-2', className)}>
      <Markdown
        allowedElements={ALLOWED}
        unwrapDisallowed
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-accent underline underline-offset-2"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <p className="font-semibold text-ink">{children}</p>,
          h2: ({ children }) => <p className="font-semibold text-ink">{children}</p>,
          h3: ({ children }) => <p className="font-semibold text-ink">{children}</p>,
          h4: ({ children }) => <p className="font-semibold text-ink">{children}</p>,
          h5: ({ children }) => <p className="font-semibold text-ink">{children}</p>,
          h6: ({ children }) => <p className="font-semibold text-ink">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border-default pl-3 text-muted">{children}</blockquote>
          ),
          code: ({ children }) => <code className="rounded bg-hover px-1 font-mono text-[0.92em]">{children}</code>,
          pre: ({ children }) => <pre className="overflow-x-auto rounded bg-hover p-2 font-mono text-meta">{children}</pre>,
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}

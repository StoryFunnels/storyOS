'use client';

import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '@/components/ui/tooltip';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

/** Minimal structural type — BlockNote's editor exposes this (#74). Some versions
 * return a string, others a Promise; `await` handles both. */
interface MarkdownSource {
  blocksToMarkdownLossy: () => string | Promise<string>;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'document'
  );
}

/** execCommand fallback — the async Clipboard API needs a focused document and a
 * secure context, so it can be unavailable even when copying is perfectly fine. */
function copyFallback(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    // ignore — `ok` stays false and the caller shows the error toast.
  }
  ta.remove();
  return ok;
}

/** #954 — shared by the icon pair below and the ⋯ menu every long-text block now has. */
export async function copyMarkdownText(md: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(md);
    return true;
  } catch {
    if (copyFallback(md)) return true;
    toast.error('Could not copy');
    return false;
  }
}

export function downloadMarkdownText(md: string, filename: string): void {
  try {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(filename)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    toast.error('Could not download');
  }
}

/** What a long-text block hands its ⋯ menu: how to get its Markdown, and what to call the file. */
export interface MarkdownProvider {
  get: () => string | Promise<string>;
  filename: string;
}

/**
 * Copy / download a rich-text field or document as Markdown (#74). Pairs with the
 * MCP Markdown round-trip (#60): what an agent reads is what you can copy out here.
 * (Record pages now reach these through the block's ⋯ menu; the icon pair remains for the document page.)
 */
export function MarkdownActions({ editor, filename }: { editor: MarkdownSource; filename: string }) {
  const [copied, setCopied] = useState(false);

  const flash = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const copy = async () => {
    if (await copyMarkdownText(await editor.blocksToMarkdownLossy())) flash();
  };

  const download = async () => downloadMarkdownText(await editor.blocksToMarkdownLossy(), filename);

  return (
    <span className="flex items-center gap-0.5">
      <Tooltip label={copied ? 'Copied' : 'Copy Markdown'}>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy as Markdown'}
          onClick={copy}
          className="rounded p-1 text-faint hover:bg-hover hover:text-ink"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </Tooltip>
      <Tooltip label="Download .md">
        <button
          type="button"
          aria-label="Download as .md"
          onClick={download}
          className="rounded p-1 text-faint hover:bg-hover hover:text-ink"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </span>
  );
}

/** The two Markdown entries of a long-text block's ⋯ menu (#954). */
export function MarkdownMenuItems({ markdown }: { markdown: MarkdownProvider }) {
  return (
    <>
      <DropdownMenuItem
        onSelect={async () => {
          if (await copyMarkdownText(await markdown.get())) toast.success('Copied');
        }}
      >
        <Copy className="mr-2 h-3.5 w-3.5" /> Copy Markdown
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={async () => downloadMarkdownText(await markdown.get(), markdown.filename)}>
        <Download className="mr-2 h-3.5 w-3.5" /> Download .md
      </DropdownMenuItem>
    </>
  );
}
